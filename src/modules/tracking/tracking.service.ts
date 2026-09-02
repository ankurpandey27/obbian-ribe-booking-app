import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { rides } from '../../common/database/schema';
import { Ride } from '../rides/entities/ride.entity';
import { GeoService } from '../../common/redis/geo.service';
import { MapsService } from '../maps/maps.service';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { RouteInfo } from '../../shared/types/common';
import { RedisCircuitBreaker } from '../../common/redis/redis-circuit-breaker.service';

const ETA_CACHE_TTL = 30; // seconds

/**
 * TrackingService — REST fallback for the socket stream (poor networks).
 * Rider polls GET /rides/:id/tracking when the socket drops; returns
 * the driver's latest position + route + ETA.
 */
@Injectable()
export class TrackingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly geo: GeoService,
    private readonly maps: MapsService,
    @InjectRedis() private readonly redis: Redis,
    private readonly breaker: RedisCircuitBreaker,
    private readonly config: ConfigService,
  ) {}

  async getTracking(rideId: string, userId?: string) {
    if (userId && !(await this.withinRestRateLimit(userId))) {
      throw new HttpException(
        'Tracking poll rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [ride] = await this.db
      .select()
      .from(rides)
      .where(eq(rides.id, rideId))
      .limit(1);
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);

    const driverPos = ride.driverId
      ? await this.geo.getDriverPosition(ride.driverId)
      : null;

    const eta = await this.getEta(ride);
    const route =
      ride.status === 'IN_PROGRESS' ||
      ride.status === 'ACCEPTED' ||
      ride.status === 'ARRIVED'
        ? await this.maps
            .getRoute(
              ride.pickupLat,
              ride.pickupLon,
              ride.dropoffLat,
              ride.dropoffLon,
            )
            .catch(() => null)
        : null;

    return {
      rideId,
      status: ride.status,
      driver: driverPos
        ? {
            lat: driverPos.lat,
            lon: driverPos.lon,
            lastUpdate: driverPos.timestamp,
          }
        : null,
      pickup: { lat: ride.pickupLat, lon: ride.pickupLon },
      dropoff: { lat: ride.dropoffLat, lon: ride.dropoffLon },
      route,
      eta,
    };
  }

  async getEta(
    ride: Ride,
  ): Promise<{ etaMinutes: number; distanceKm: number }> {
    const cacheKey = `eta:${ride.id}`;
    const cached = await this.breaker.execute('tracking_cache', 'open', () =>
      this.redis.get(cacheKey),
    );
    if (cached) return JSON.parse(cached);

    const driverPos = ride.driverId
      ? await this.geo.getDriverPosition(ride.driverId)
      : null;

    if (!driverPos) {
      return {
        etaMinutes: ride.durationMin,
        distanceKm: Number(ride.distanceKm),
      };
    }

    const origin =
      ride.status === 'IN_PROGRESS'
        ? driverPos
        : { lat: driverPos.lat, lon: driverPos.lon };
    const dest =
      ride.status === 'IN_PROGRESS'
        ? { lat: ride.dropoffLat, lon: ride.dropoffLon }
        : { lat: ride.pickupLat, lon: ride.pickupLon };

    const route = await this.maps
      .getRoute(origin.lat, origin.lon, dest.lat, dest.lon)
      .catch((): RouteInfo | null => null);

    const result = route
      ? {
          etaMinutes: Math.max(1, Math.round(route.durationMin)),
          distanceKm: route.distanceKm,
        }
      : { etaMinutes: ride.durationMin, distanceKm: Number(ride.distanceKm) };

    await this.breaker.execute('tracking_cache', 'open', () =>
      this.redis.set(cacheKey, JSON.stringify(result), 'EX', ETA_CACHE_TTL),
    );
    return result;
  }

  async refreshEtaForMovement(
    rideId: string,
  ): Promise<{ etaMinutes: number; distanceKm: number } | null> {
    const [ride] = await this.db
      .select()
      .from(rides)
      .where(eq(rides.id, rideId))
      .limit(1);
    if (
      !ride ||
      !['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'].includes(ride.status) ||
      !ride.driverId
    ) {
      return null;
    }

    const lock = await this.breaker
      .execute('eta_rate_limit', 'closed', () =>
        this.redis.set(
          `eta:refresh:${rideId}`,
          '1',
          'EX',
          this.config.get<number>('eta.refreshIntervalSeconds', 30),
          'NX',
        ),
      )
      .catch(() => undefined);
    if (lock !== 'OK') return null;

    const driverPos = await this.geo.getDriverPosition(ride.driverId);
    if (!driverPos) return null;
    const destination =
      ride.status === 'IN_PROGRESS'
        ? { lat: ride.dropoffLat, lon: ride.dropoffLon }
        : { lat: ride.pickupLat, lon: ride.pickupLon };
    const route = await this.maps
      .getRoute(driverPos.lat, driverPos.lon, destination.lat, destination.lon)
      .catch(() => null);
    if (!route) return null;

    const result = {
      etaMinutes: Math.max(1, Math.round(Number(route.durationMin))),
      distanceKm: route.distanceKm,
    };
    await Promise.all([
      this.db
        .update(rides)
        .set({ etaMinutes: result.etaMinutes, etaUpdatedAt: new Date() })
        .where(eq(rides.id, rideId)),
      this.breaker.execute('tracking_cache', 'open', () =>
        this.redis.set(
          `eta:${rideId}`,
          JSON.stringify(result),
          'EX',
          ETA_CACHE_TTL,
        ),
      ),
    ]);
    return result;
  }

  private async withinRestRateLimit(userId: string): Promise<boolean> {
    const limit = this.config.get<number>(
      'tracking.restRateLimitPerMinute',
      60,
    );
    const count = await this.breaker.execute(
      'tracking_rate_limit',
      'open',
      async () => {
        const key = `ratelimit:tracking:${userId}`;
        const hits = await this.redis.incr(key);
        if (hits === 1) await this.redis.expire(key, 60);
        return hits;
      },
    );
    return count === undefined || count <= limit;
  }
}
