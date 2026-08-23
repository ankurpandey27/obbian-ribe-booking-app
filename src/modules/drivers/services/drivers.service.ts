import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { GeoService } from '../../../common/redis/geo.service';
import { DriverStatusValue, RideTypeValue } from '../../../shared/types/common';
import { RegisterDriverDto } from '../dto/drivers.dto';

const HEARTBEAT_TTL_SECONDS = 90;

/**
 * DriversService — driver profile + online status + live position.
 * Online state lives in Redis (geo index + heartbeat TTL); profile in DB.
 * Auto-offline: if a driver stops pinging for 90s they drop out of the
 * geo index — a dead driver can never be matched.
 */
@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(Driver) private readonly driverRepo: Repository<Driver>,
    private readonly geo: GeoService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Register driver profile + promote user role to DRIVER.
   * Both writes run in ONE transaction: a partial state (profile without
   * role, or role without profile) is impossible by construction.
   * Client re-verifies OTP afterwards to pick up the DRIVER role in the JWT.
   */
  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.driverRepo.findOneBy({ userId });
    if (existing) {
      throw new ConflictException(
        'Driver profile already exists for this user',
      );
    }

    return this.dataSource.transaction(async (em) => {
      const driver = await em.save(Driver, {
        userId,
        licenseNumber: dto.licenseNumber,
        vehicleRegistration: dto.vehicleRegistration,
        vehicleModel: dto.vehicleModel,
        vehicleColor: dto.vehicleColor,
        vehicleType: dto.vehicleType,
        upiId: dto.upiId,
        status: 'OFFLINE',
      });
      // Parameterized update against the users table within the same tx.
      await em.update('users', { id: userId }, { role: 'DRIVER' });
      return driver;
    });
  }

  async getProfile(driverId: string): Promise<Driver> {
    const driver = await this.driverRepo.findOneBy({ userId: driverId });
    if (!driver) throw new NotFoundException(`Driver ${driverId} not found`);
    return driver;
  }

  async updateStatus(
    driverId: string,
    status: DriverStatusValue,
  ): Promise<void> {
    await this.getProfile(driverId);
    await this.driverRepo.update(driverId, {
      status,
      onlineSince: status === 'ONLINE' ? new Date() : undefined,
    });

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
    await this.driverRepo.update(driverId, {
      status: 'ONLINE',
      onlineSince: new Date(),
    });
    await this.driverRepo.increment({ userId: driverId }, 'totalRides', 1);
    await this.geo.upsertDriverPosition(driverId, lon, lat);
    await this.geo.cacheDriverPosition(driverId, lat, lon, Date.now());
    await this.setHeartbeat(driverId);
  }

  /**
   * Live position update — refreshes geo index + heartbeat TTL.
   * Also writes the location cache the tracking service (REST fallback)
   * reads when the rider's socket is down.
   * Only ONLINE or ON_RIDE drivers stay matchable.
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
    await this.driverRepo.update(driverId, {
      lastLocationUpdateAt: new Date(),
    });

    // Heartbeat TTL: expires → driver auto-removed from matchable pool.
    await this.setHeartbeat(driverId);
  }

  /** Refresh online heartbeat. Called on every location ping. */
  async setHeartbeat(driverId: string): Promise<void> {
    await this.geo.setHeartbeat(driverId, HEARTBEAT_TTL_SECONDS);
  }

  /**
   * Returns candidate drivers for matching, pre-filtered by vehicle type.
   * Three-stage filter, cheapest first: geo radius (Redis) → heartbeat
   * freshness (Redis pipeline) → status/vehicle (Postgres). A driver who
   * stopped pinging is excluded here — never offered a ride.
   */
  async findMatchableDrivers(
    lon: number,
    lat: number,
    radiusKm: number,
    vehicleType: RideTypeValue,
    limit = 20,
  ): Promise<Driver[]> {
    const geoIds = await this.geo.findNearbyDriverIds(lon, lat, radiusKm, limit);
    if (geoIds.length === 0) return [];

    const freshIds = await this.geo.filterFreshDrivers(geoIds);
    if (freshIds.length === 0) return [];

    return this.driverRepo
      .createQueryBuilder('d')
      .where('d.userId IN (:...ids)', { ids: freshIds })
      .andWhere('d.status = :status', { status: 'ONLINE' })
      .andWhere('d.vehicleType = :vehicleType', { vehicleType })
      .orderBy('d.rating', 'DESC')
      .getMany();
  }

  /** Validate a location ping is plausible (max 200 km/h vs last position). */
  async validateLocationJump(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
  ): Promise<boolean> {
    const prev = await this.geo.getDriverPosition(driverId);
    if (!prev) return true;

    const timeDiff = (timestamp - prev.timestamp) / 1000;
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
