import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { drivers as driversTable, users } from '../../common/database/schema';
import { Driver } from './entities/driver.entity';
import { GeoService } from '../../common/redis/geo.service';
import { DriverStatusValue, RideTypeValue } from '../../shared/types/common';
import { RegisterDriverDto } from './dto/drivers.dto';

const HEARTBEAT_TTL_SECONDS = 90;

/**
 * DriversService — driver profile + online status + live position.
 * Online state lives in Redis (geo index + heartbeat TTL); profile in DB
 * via Drizzle. Auto-offline: heartbeat freshness is enforced at match
 * time (findMatchableDrivers) — a dead driver can never be matched.
 */
@Injectable()
export class DriversService {
  private readonly enforceComplianceForDispatch: boolean;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly geo: GeoService,
    config: ConfigService,
  ) {
    this.enforceComplianceForDispatch = config.get<boolean>(
      'compliance.enforceForDispatch',
      true,
    );
  }

  private async findById(driverId: string) {
    const [row] = await this.db
      .select()
      .from(driversTable)
      .where(eq(driversTable.userId, driverId))
      .limit(1);
    return row;
  }

  /**
   * Register driver profile + promote user role to DRIVER.
   * Both writes run in ONE transaction: a partial state (profile without
   * role, or role without profile) is impossible by construction.
   * Client re-verifies OTP afterwards to pick up the DRIVER role in the JWT.
   */
  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.findById(userId);
    if (existing) {
      throw new ConflictException(
        'Driver profile already exists for this user',
      );
    }

    return this.db.transaction(async (tx) => {
      const [driver] = await tx
        .insert(driversTable)
        .values({
          userId,
          licenseNumber: dto.licenseNumber,
          vehicleRegistration: dto.vehicleRegistration,
          vehicleModel: dto.vehicleModel,
          vehicleColor: dto.vehicleColor,
          vehicleType: dto.vehicleType,
          upiId: dto.upiId,
          status: 'OFFLINE',
        })
        .returning();
      await tx
        .update(users)
        .set({ role: 'DRIVER', updatedAt: new Date() })
        .where(eq(users.id, userId));
      return driver;
    });
  }

  async getProfile(driverId: string): Promise<Driver> {
    const driver = await this.findById(driverId);
    if (!driver) throw new NotFoundException(`Driver ${driverId} not found`);
    return driver;
  }

  /**
   * Set driver availability.
   *
   * COMPLIANCE GATE: going ONLINE is refused unless every required document is
   * verified and unexpired (migration 006, ADR-013). Dispatching a driver with
   * a lapsed licence or insurance is a regulatory violation, so this is a hard
   * refusal rather than a warning. The check is a single boolean read on the
   * driver row — no join — because it sits on the availability path.
   *
   * `compliance.enforceForDispatch` can disable it for local seeding only; the
   * config layer refuses to boot production with it off.
   */
  async updateStatus(
    driverId: string,
    status: DriverStatusValue,
  ): Promise<void> {
    const driver = await this.getProfile(driverId);

    if (
      status === 'ONLINE' &&
      this.enforceComplianceForDispatch &&
      !driver.isComplianceVerified
    ) {
      throw new ForbiddenException(
        'Cannot go online until your documents are verified. ' +
          'Check GET /compliance/me for what is outstanding.',
      );
    }

    await this.db
      .update(driversTable)
      .set({
        status,
        onlineSince: status === 'ONLINE' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(driversTable.userId, driverId));

    if (status === 'OFFLINE' || status === 'ON_RIDE') {
      await this.geo.removeDriverPosition(driverId);
    }
  }

  /**
   * Post-completion restore: driver back ONLINE, re-added to the geo
   * pool at the pickup point + rides count bumped. Called by RidesService
   * on RIDE_COMPLETED.
   */
  async completeRide(
    driverId: string,
    lat: number,
    lon: number,
  ): Promise<void> {
    await this.db
      .update(driversTable)
      .set({
        status: 'ONLINE',
        onlineSince: new Date(),
        totalRides: sql`${driversTable.totalRides} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(driversTable.userId, driverId));
    await this.geo.upsertDriverPosition(driverId, lon, lat);
    await this.geo.cacheDriverPosition(driverId, lat, lon, Date.now());
    await this.setHeartbeat(driverId);
  }

  /**
   * Live position update — refreshes geo index + heartbeat TTL.
   * Also writes the location cache the tracking service (REST fallback)
   * reads when the rider's socket is down.
   *
   * HOT-PATH RULE (AGENTS.md §7): GPS pings never touch Postgres. The geo
   * index, position cache, and heartbeat are all Redis-only. A Postgres
   * lastLocationUpdateAt write on every 3–5s ping per driver would be a
   * write-storm at scale (200K concurrent captains → 40K+ writes/sec to a
   * shared table). That column is updated lazily by the matching/settlement
   * paths that actually need it, not here.
   */
  async updateLocation(
    driverId: string,
    lat: number,
    lon: number,
    timestamp?: number,
  ): Promise<void> {
    await this.geo.upsertDriverPosition(driverId, lon, lat);
    await this.geo.cacheDriverPosition(
      driverId,
      lat,
      lon,
      timestamp ?? Date.now(),
    );

    // Heartbeat TTL: expires → driver excluded at match time (see below).
    await this.setHeartbeat(driverId);
  }

  /** Refresh online heartbeat. Called on every location ping. */
  async setHeartbeat(driverId: string): Promise<void> {
    await this.geo.setHeartbeat(driverId, HEARTBEAT_TTL_SECONDS);
  }

  /**
   * Returns candidate drivers for matching, pre-filtered by vehicle type.
   * Three-stage filter, cheapest first: geo radius (Redis) → heartbeat
   * freshness (Redis pipeline) → status/vehicle/compliance (Postgres). A driver
   * who stopped pinging is excluded here — never offered a ride.
   *
   * COMPLIANCE GATE (second of two): `updateStatus` refuses to put a
   * non-compliant driver ONLINE, but a driver can lose eligibility WHILE online
   * (nightly expiry sweep, an ops rejection, a vehicle swap). Filtering here
   * too means dispatch is correct even in that window. Backed by the partial
   * index `IDX_drivers_matchable`, whose predicate is exactly
   * `status = 'ONLINE' AND isComplianceVerified = true` — so this extra
   * condition makes the query cheaper, not more expensive.
   */
  async findMatchableDrivers(
    lon: number,
    lat: number,
    radiusKm: number,
    vehicleType: RideTypeValue,
    limit = 20,
  ): Promise<Driver[]> {
    const geoIds = await this.geo.findNearbyDriverIds(
      lon,
      lat,
      radiusKm,
      limit,
    );
    if (geoIds.length === 0) return [];

    const freshIds = await this.geo.filterFreshDrivers(geoIds);
    if (freshIds.length === 0) return [];

    const conditions = [
      inArray(driversTable.userId, freshIds),
      eq(driversTable.status, 'ONLINE'),
      eq(driversTable.vehicleType, vehicleType),
    ];
    if (this.enforceComplianceForDispatch) {
      conditions.push(eq(driversTable.isComplianceVerified, true));
    }

    return this.db
      .select()
      .from(driversTable)
      .where(and(...conditions))
      .orderBy(sql`${driversTable.rating} DESC`);
  }

  /**
   * Validate a location ping is plausible (max 200 km/h vs last position).
   *
   * Server-clock authority: the driver-supplied timestamp is NOT trusted for
   * the time delta (a client can freeze or advance it to inflate the allowed
   * distance). Instead we use the cached position's server-recorded timestamp
   * (set by cacheDriverPosition at ingest time) vs the current server clock.
   * A driver-supplied timestamp more than MAX_CLOCK_SKEW_SECONDS off server
   * time is rejected outright.
   */
  async validateLocationJump(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
  ): Promise<boolean> {
    const prev = await this.geo.getDriverPosition(driverId);
    if (!prev) return true;

    // Reject driver timestamps that are too far from server clock (prevents
    // frozen/future timestamps from inflating the allowed jump distance).
    const MAX_CLOCK_SKEW_SECONDS = 60;
    const now = Date.now();
    if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS * 1000) {
      return false;
    }

    // Server-authoritative time delta: cached position timestamp vs now.
    const timeDiff = (now - prev.timestamp) / 1000;
    if (timeDiff <= 0) return false;

    const distKm = this.haversine(prev.lat, prev.lon, lat, lon);
    const maxKm = (200 / 3600) * timeDiff;
    return distKm <= maxKm + 0.05;
  }

  async getNearbyDriverIds(
    lon: number,
    lat: number,
    radiusKm: number,
    limit = 50,
  ): Promise<string[]> {
    return this.geo.findNearbyDriverIds(lon, lat, radiusKm, limit);
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
