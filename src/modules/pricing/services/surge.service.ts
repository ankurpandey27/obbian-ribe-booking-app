import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Driver } from '../../drivers/entities/driver.entity';

/**
 * SurgeService — demand/supply dynamic pricing.
 * demand  = ride requests in the last N minutes (Redis counter).
 * supply  = ONLINE drivers in that city right now (DB count).
 * ratio   = demand / max(supply, 1).
 * multiplier climbs from 1.0 once ratio > demandThreshold, capped at
 * maxMultiplier, stepped by multiplierStep. Cached in Redis (TTL) so
 * every quote in the same window pays the same surge.
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
    @InjectRepository(Driver) private readonly driverRepo: Repository<Driver>,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('surge.enabled', false);
    this.maxMultiplier = config.get<number>('surge.maxMultiplier', 2.5);
    this.windowMinutes = config.get<number>('surge.windowMinutes', 10);
    this.demandThreshold = config.get<number>('surge.demandThreshold', 1.5);
    this.multiplierStep = config.get<number>('surge.multiplierStep', 0.25);
    this.cacheTtlSeconds = config.get<number>('surge.cacheTtlSeconds', 60);
  }

  /** Record one demand unit for a city (ride requested). */
  async recordDemand(city: string): Promise<void> {
    if (!this.enabled) return;
    const key = `surge:demand:${city}`;
    await this.redis.incr(key);
    await this.redis.expire(key, this.windowMinutes * 60);
  }

  /**
   * Current surge multiplier for a city — 1.0 when disabled or calm.
   * Cached so concurrent quotes agree within the cache window.
   */
  async getMultiplier(city: string): Promise<number> {
    if (!this.enabled) return 1.0;

    const cacheKey = `surge:multiplier:${city}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return parseFloat(cached);

    const [demandRaw, supplyRaw] = await Promise.all([
      this.redis.get(`surge:demand:${city}`),
      this.driverRepo.count({ where: { status: 'ONLINE' } }),
    ]);
    const demand = Number(demandRaw ?? 0);
    const supply = Math.max(supplyRaw, 1);
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
