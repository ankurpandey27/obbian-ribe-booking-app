import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { cellToLatLng, latLngToCell } from 'h3-js';
import { GeoService } from '../../../common/redis/geo.service';

/**
 * Resolution 8 (~460m avg edge) — neighbourhood granularity. Demand and
 * supply are aggregated per cell so a burst in one area never surges the
 * whole city (the flaw of city-wide surge), mirroring Uber/Rapido practice.
 */
const SURGE_H3_RESOLUTION = 8;
/** Supply = ONLINE drivers within this radius of the cell centre. */
const SUPPLY_RADIUS_KM = 2.5;

/**
 * SurgeService — demand/supply dynamic pricing on H3 cells.
 * demand  = ride requests in the last N minutes FOR THE CELL (Redis counter).
 * supply  = drivers near the cell centre right now (geo index).
 * ratio   = demand / max(supply, 1); multiplier climbs past demandThreshold,
 * capped at maxMultiplier, stepped by multiplierStep. Cached per cell so
 * every quote inside one cache window agrees.
 */
@Injectable()
export class SurgeService {
  private readonly logger = new Logger(SurgeService.name);
  private readonly enabled: boolean;
  private readonly maxMultiplier: number;
  private readonly windowMinutes: number;
  private readonly demandThreshold: number;
  private readonly multiplierStep: number;
  private readonly cacheTtlSeconds: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly geo: GeoService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('surge.enabled', false);
    this.maxMultiplier = config.get<number>('surge.maxMultiplier', 2.5);
    this.windowMinutes = config.get<number>('surge.windowMinutes', 10);
    this.demandThreshold = config.get<number>('surge.demandThreshold', 1.5);
    this.multiplierStep = config.get<number>('surge.multiplierStep', 0.25);
    this.cacheTtlSeconds = config.get<number>('surge.cacheTtlSeconds', 60);
  }

  /** H3 cell index for a pickup point at the configured resolution. */
  toCell(lat: number, lon: number): string {
    return latLngToCell(lat, lon, SURGE_H3_RESOLUTION);
  }

  /** Record one demand unit for a pickup cell (ride requested). */
  async recordDemand(city: string, lat: number, lon: number): Promise<void> {
    if (!this.enabled) return;
    const key = `surge:demand:${city}:${this.toCell(lat, lon)}`;
    await this.redis.incr(key);
    await this.redis.expire(key, this.windowMinutes * 60);
  }

  /**
   * Current surge multiplier for a pickup cell — 1.0 when disabled/calm.
   * Cached per cell so concurrent quotes agree within the cache window.
   */
  async getMultiplier(city: string, lat: number, lon: number): Promise<number> {
    if (!this.enabled) return 1.0;

    const cell = this.toCell(lat, lon);
    const cacheKey = `surge:multiplier:${city}:${cell}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return parseFloat(cached);

    // Cell centroid as the supply probe — deterministic per cell, so all
    // requests mapping to the same cell measure the same supply pool.
    const [centerLat, centerLon] = cellToLatLng(cell);
    const [demandRaw, supplyIds] = await Promise.all([
      this.redis.get(`surge:demand:${city}:${cell}`),
      this.geo
        .findNearbyDriverIds(centerLon, centerLat, SUPPLY_RADIUS_KM, 500)
        .catch(() => [] as string[]),
    ]);
    const demand = Number(demandRaw ?? 0);
    const supply = Math.max(supplyIds.length, 1);
    const ratio = demand / supply;

    let multiplier = 1.0;
    if (ratio > this.demandThreshold) {
      const steps = Math.ceil(
        (ratio - this.demandThreshold) / this.multiplierStep,
      );
      multiplier = Math.min(
        this.maxMultiplier,
        1 + steps * this.multiplierStep,
      );
    }

    const rounded = Math.round(multiplier * 100) / 100;
    await this.redis
      .set(cacheKey, String(rounded), 'EX', this.cacheTtlSeconds)
      .catch((err) =>
        this.logger.warn(`surge cache write failed: ${err.message}`),
      );
    return rounded;
  }
}
