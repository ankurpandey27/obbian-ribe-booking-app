import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.constants';
import { Redis } from 'ioredis';
import { nearestServiceCity } from '../../shared/cities';
import { RedisCircuitBreaker } from './redis-circuit-breaker.service';

/**
 * Compatibility: the old global key is kept for backwards compatibility
 * with seed data and tests. The real keys are now sharded per city.
 * @deprecated Use geoKey() for new code.
 */
export const DRIVERS_GEO_KEY = 'drivers:geo';

/**
 * Geo index keys are SHARDED PER CITY (`drivers:geo:{city}`): a single global
 * zset was the #1 Redis hotspot and cross-city noise source at scale. The
 * shard is derived from the coordinate itself, so callers never thread city
 * through their signatures.
 */
export const DRIVERS_GEO_PREFIX = 'drivers:geo:';

function geoKey(lon: number, lat: number): string {
  return `${DRIVERS_GEO_PREFIX}${nearestServiceCity(lat, lon).name}`;
}

/**
 * Geo helpers over ioredis — the geo-index is the matching source of truth.
 * NOTE Redis GEOADD/GEORADIUS argument order: longitude first, then latitude.
 */
@Injectable()
export class GeoService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly breaker: RedisCircuitBreaker,
  ) {}

  async upsertDriverPosition(
    driverId: string,
    lon: number,
    lat: number,
  ): Promise<void> {
    await this.breaker.execute('geo_write', 'open', () =>
      this.redis.geoadd(geoKey(lon, lat), lon, lat, driverId),
    );
  }

  /**
   * Remove a driver's pin. Without coordinates we sweep every city shard —
   * 8 ZREMs is cheaper than threading cached position lookups through the
   * offline path, and stale pins in wrong shards get cleaned anyway.
   */
  async removeDriverPosition(driverId: string): Promise<void> {
    const cities = [
      'Delhi',
      'Noida',
      'Gurugram',
      'Bangalore',
      'Mumbai',
      'Hyderabad',
      'Pune',
      'Chennai',
    ];
    await Promise.all(
      cities.map((name) =>
        this.breaker.execute('geo_write', 'open', () =>
          this.redis.zrem(`${DRIVERS_GEO_PREFIX}${name}`, driverId),
        ),
      ),
    );
  }

  /**
   * Find driver IDs within radius (km) of a point, closest first.
   * Returns the raw member list; caller filters by vehicle/status.
   */
  async findNearbyDriverIds(
    lon: number,
    lat: number,
    radiusKm: number,
    limit = 50,
  ): Promise<string[]> {
    const members = await this.breaker.execute('geo_lookup', 'open', () =>
      this.redis.georadius(
        geoKey(lon, lat),
        lon,
        lat,
        radiusKm,
        'km',
        'COUNT',
        limit,
        'ASC',
      ),
    );
    return (members as string[] | undefined) ?? [];
  }

  /** Returns cached position {lat, lon, timestamp} or null. */
  async getDriverPosition(
    driverId: string,
  ): Promise<{ lat: number; lon: number; timestamp: number } | null> {
    const raw = await this.breaker.execute('location_lookup', 'open', () =>
      this.redis.get(`driver:${driverId}:location`),
    );
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Keep only drivers whose heartbeat key is still alive (TTL not expired).
   * This is what makes a driver who stopped pinging (app killed, no network)
   * un-matchable within HEARTBEAT_TTL_SECONDS — enforced at match time, not
   * by a cleanup cron. Single pipelined round-trip regardless of batch size.
   */
  async filterFreshDrivers(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of driverIds) {
      pipeline.exists(`driver:${id}:heartbeat`);
    }
    const results = await this.breaker.execute('geo_lookup', 'open', () =>
      pipeline.exec(),
    );
    if (!results) return [];
    const fresh: string[] = [];
    results.forEach(([err, exists], i) => {
      if (!err && Number(exists) === 1) fresh.push(driverIds[i]);
    });
    return fresh;
  }

  /** Set (or refresh) the driver's online heartbeat with TTL. */
  async setHeartbeat(driverId: string, ttlSeconds: number): Promise<void> {
    await this.breaker.execute('heartbeat_write', 'open', () =>
      this.redis.set(`driver:${driverId}:heartbeat`, '1', 'EX', ttlSeconds),
    );
  }

  /** Cache latest position for the REST tracking fallback. */
  async cacheDriverPosition(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
    ttlSeconds = 300,
  ): Promise<void> {
    await this.breaker.execute('location_write', 'open', () =>
      this.redis.setex(
        `driver:${driverId}:location`,
        ttlSeconds,
        JSON.stringify({ lat, lon, timestamp }),
      ),
    );
  }
}
