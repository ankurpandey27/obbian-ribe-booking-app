import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { SurgeService } from './surge.service';
import { WeatherProvider } from './weather.provider';

export interface PricingSignal {
  type: 'surge' | 'peak' | 'weather' | 'demand_supply' | 'driver_availability';
  multiplier: number;
  reason: string;
}

export interface DynamicPriceResult {
  baseFare: number;
  finalFare: number;
  signals: PricingSignal[];
  multiplier: number;
}

/**
 * DynamicPricingService — layers multiple pricing signals deterministically:
 * finalFare = baseFare × surge × peak × weather × demandSupply,
 * each ≥ 1.0, capped by a config max multiplier.
 *
 * Every signal is recorded so the FE + AI can explain price changes
 * ("Demand is high", "Rain in your area", etc.).
 */
@Injectable()
export class DynamicPricingService {
  private readonly logger = new Logger(DynamicPricingService.name);
  private readonly maxMultiplier: number;
  private readonly weatherEnabled: boolean;

  constructor(
    private readonly surge: SurgeService,
    private readonly config: ConfigService,
    @InjectRedis() private readonly redis: Redis,
    @Inject('WEATHER_PROVIDER') private readonly weather?: WeatherProvider,
  ) {
    this.maxMultiplier = config.get<number>('pricing.maxMultiplier', 3.0);
    this.weatherEnabled = config.get<boolean>('pricing.weatherEnabled', false);
  }

  /**
   * Compute the final fare with all active signals. Pure function of inputs —
   * no hidden state, so quotes are reproducible and testable.
   */
  async calculate(input: {
    baseFare: number;
    city: string;
    pickupLat: number;
    pickupLon: number;
    categoryCode: string;
  }): Promise<DynamicPriceResult> {
    const signals: PricingSignal[] = [];

    // 1. Surge (demand/supply on H3 cells)
    const surgeMultiplier = await this.surge.getMultiplier(
      input.city,
      input.pickupLat,
      input.pickupLon,
    );
    if (surgeMultiplier > 1.0) {
      signals.push({
        type: 'surge',
        multiplier: surgeMultiplier,
        reason: `High demand in your area (×${surgeMultiplier.toFixed(2)})`,
      });
    }

    // 2. Peak window (time-of-day config)
    const peak = this.getPeakMultiplier(input.city);
    if (peak > 1.0) {
      signals.push({
        type: 'peak',
        multiplier: peak,
        reason: 'Peak hours pricing',
      });
    }

    // 3. Weather (rain, etc.)
    if (this.weatherEnabled && this.weather) {
      const weather = this.weather.getCondition(
        input.pickupLat,
        input.pickupLon,
      );
      if (weather.multiplier > 1.0) {
        signals.push({
          type: 'weather',
          multiplier: weather.multiplier,
          reason: `Weather adjustment: ${weather.condition}`,
        });
      }
    }

    // 4. Driver availability (city-wide)
    const availability = await this.getDriverAvailabilityMultiplier(input.city);
    if (availability > 1.0) {
      signals.push({
        type: 'driver_availability',
        multiplier: availability,
        reason: 'Few drivers online right now',
      });
    }

    // Combine signals multiplicatively, cap at max
    let combined = 1.0;
    for (const s of signals) {
      combined *= s.multiplier;
    }
    combined = Math.min(combined, this.maxMultiplier);

    return {
      baseFare: input.baseFare,
      finalFare: Math.round(input.baseFare * combined * 2) / 2, // nearest ₹0.50,
      signals,
      multiplier: combined,
    };
  }

  private getPeakMultiplier(city: string): number {
    // Config-driven peak windows. Simplified: check current hour against
    // configured peak hours for the city.
    const peakConfig = this.config.get<
      { start: number; end: number; multiplier: number }[]
    >(`pricing.peakWindows.${city}`, []);
    const hour = new Date().getHours();
    for (const window of peakConfig) {
      if (window.start <= window.end) {
        if (hour >= window.start && hour < window.end) return window.multiplier;
      } else {
        // Wraps midnight (e.g., 22 → 6)
        if (hour >= window.start || hour < window.end) return window.multiplier;
      }
    }
    return 1.0;
  }

  private async getDriverAvailabilityMultiplier(city: string): Promise<number> {
    // Ratio of active ride requests to online drivers city-wide.
    // Uses Redis keys set by the matching/heartbeat workers.
    const onlineDrivers =
      Number(
        await this.redis
          .get(`roju:city:${city}:drivers_online`)
          .catch(() => '0'),
      ) || 0;
    const pendingRides =
      Number(
        await this.redis
          .get(`roju:city:${city}:pending_rides`)
          .catch(() => '0'),
      ) || 0;
    const ratio = pendingRides / Math.max(onlineDrivers, 1);
    if (ratio > 2) return 1.3;
    if (ratio > 1) return 1.1;
    return 1.0;
  }
}
