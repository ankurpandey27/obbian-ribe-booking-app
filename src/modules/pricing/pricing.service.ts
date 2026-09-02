import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { FareConfig } from './entities/fare-config.entity';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { fareConfigs } from '../../common/database/schema';
import { MapsService } from '../maps/maps.service';
import { SurgeService } from './surge.service';
import { RideTypeValue } from '../../shared/types/common';

export class QuoteOption {
  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @ApiProperty({ example: 718.5, description: 'Estimated fare in INR' })
  fare: number;

  @ApiProperty({ example: 41, description: 'ETA in minutes' })
  etaMinutes: number;

  @ApiProperty({ example: 1.0 })
  surgeMultiplier: number;

  @ApiProperty({ example: 60 })
  baseFare: number;
}

export class QuoteResult {
  @ApiProperty({ type: [QuoteOption] })
  options: QuoteOption[];

  @ApiProperty({ example: 42.14, description: 'Road distance in km' })
  distanceKm: number;

  @ApiProperty({ example: 45.7, description: 'Road duration in minutes' })
  durationMin: number;

  @ApiPropertyOptional({
    example: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    description: 'Encoded polyline of the route',
  })
  polyline?: string;

  @ApiProperty({ example: 'Delhi' })
  city: string;

  @ApiPropertyOptional({
    example: 1.0,
    description: 'Dynamic surge (1.0 = none)',
  })
  surgeMultiplier?: number;
}

/**
 * PricingService — quote engine. Road distance from MapsService (never
 * haversine), fare from DB config: base + (km × rate) + (min × rate),
 * floored at minimum, times surge. The quote is what /rides/request
 * validates against (price lock).
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly maps: MapsService,
    private readonly surge: SurgeService,
  ) {}

  async getQuote(
    pickupLat: number,
    pickupLon: number,
    dropoffLat: number,
    dropoffLon: number,
    city: string,
    rideTypes?: RideTypeValue[],
  ): Promise<QuoteResult> {
    const route = await this.maps.getRoute(
      pickupLat,
      pickupLon,
      dropoffLat,
      dropoffLon,
    );
    const types = rideTypes?.length ? rideTypes : undefined;

    const allConfigs = await this.db
      .select()
      .from(fareConfigs)
      .where(and(eq(fareConfigs.city, city), eq(fareConfigs.isActive, true)));
    const configs = types
      ? allConfigs.filter((c) => types.includes(c.rideType))
      : allConfigs;
    if (configs.length === 0) {
      throw new NotFoundException(`No fare config for city: ${city}`);
    }

    const options: QuoteOption[] = configs
      .sort((a, b) => Number(a.baseFare) - Number(b.baseFare))
      .map((c) => ({
        rideType: c.rideType,
        baseFare: Number(c.baseFare),
        fare: this.calculateFare(c, route.distanceKm, route.durationMin),
        etaMinutes: this.estimateEta(route.durationMin, c.rideType),
        surgeMultiplier: Number(c.surgeMultiplier),
      }));

    // Dynamic surge layered on top of the config multiplier (per pickup cell).
    const surgeMultiplier = await this.surge.getMultiplier(
      city,
      pickupLat,
      pickupLon,
    );
    if (surgeMultiplier > 1.0) {
      for (const option of options) {
        option.fare = this.applySurge(option.fare, surgeMultiplier);
        option.surgeMultiplier = surgeMultiplier;
      }
    }

    return {
      options,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      polyline: route.polyline,
      city,
      surgeMultiplier,
    };
  }

  private applySurge(fare: number, multiplier: number): number {
    return Math.round(fare * multiplier * 2) / 2; // nearest ₹0.50
  }

  /** Fare for a locked ride — used at completion and payment. */
  calculateFare(
    config: FareConfig,
    distanceKm: number,
    durationMin: number,
  ): number {
    const raw =
      Number(config.baseFare) +
      Number(config.perKmRate) * distanceKm +
      Number(config.perMinuteRate) * durationMin;
    const floored = Math.max(raw, Number(config.minimumFare));
    const surged = floored * Number(config.surgeMultiplier);
    return Math.round(surged * 2) / 2; // nearest ₹0.50
  }

  async getConfig(city: string, rideType: RideTypeValue): Promise<FareConfig> {
    const [config] = await this.db
      .select()
      .from(fareConfigs)
      .where(
        and(
          eq(fareConfigs.city, city),
          eq(fareConfigs.rideType, rideType),
          eq(fareConfigs.isActive, true),
        ),
      )
      .limit(1);
    if (!config)
      throw new NotFoundException(`Fare config missing: ${city}/${rideType}`);
    return config;
  }

  private estimateEta(durationMin: number, rideType: RideTypeValue): number {
    const factor: Record<RideTypeValue, number> = {
      CABX_SAVER: 0.9,
      CABX: 0.9,
      CABXL: 0.95,
      COMFORT: 0.95,
      AUTO: 1.1,
      TWO_WHEELER: 1.0,
    };
    return Math.max(1, Math.round(durationMin * (factor[rideType] ?? 1)));
  }
}
