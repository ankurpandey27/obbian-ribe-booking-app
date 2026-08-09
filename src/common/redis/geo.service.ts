import { Inject, Injectable } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.module';
import { Redis } from 'ioredis';

/** Geo index key for online drivers (longitude, latitude, driverId). */
export const DRIVERS_GEO_KEY = 'drivers:geo';

/**
 * Geo helpers over ioredis — the geo-index is the matching source of truth.
 * NOTE Redis GEORADIUS argument order: longitude first, then latitude.
 */
@Injectable()
export class GeoService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async upsertDriverPosition(
    driverId: string,
    lon: number,
    lat: number,
  ): Promise<void> {
    await this.redis.geoadd(DRIVERS_GEO_KEY, lon, lat, driverId);
  }

  async removeDriverPosition(driverId: string): Promise<void> {
    await this.redis.zrem(DRIVERS_GEO_KEY, driverId);
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
    const members = await this.redis.georadius(
      DRIVERS_GEO_KEY,
      lon,
      lat,
      radiusKm,
      'km',
      'COUNT',
      limit,
      'ASC',
    );
    return members as string[];
  }

  /** Returns cached position {lat, lon, timestamp} or null. */
  async getDriverPosition(
    driverId: string,
  ): Promise<{ lat: number; lon: number; timestamp: number } | null> {
    const raw = await this.redis.get(`driver:${driverId}:location`);
    return raw ? JSON.parse(raw) : null;
  }

  /** Set (or refresh) the driver's online heartbeat with TTL. */
  async setHeartbeat(driverId: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`driver:${driverId}:heartbeat`, '1', 'EX', ttlSeconds);
  }

  /** Cache latest position for the REST tracking fallback. */
  async cacheDriverPosition(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
    ttlSeconds = 300,
  ): Promise<void> {
    await this.redis.setex(
      `driver:${driverId}:location`,
      ttlSeconds,
      JSON.stringify({ lat, lon, timestamp }),
    );
  }
}
