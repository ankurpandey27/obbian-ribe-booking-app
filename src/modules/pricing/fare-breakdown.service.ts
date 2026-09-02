import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { rideFareBreakdown } from '../../common/database/schema';
import { FareConfig } from './entities/fare-config.entity';
import {
  nonNegativePaise,
  percentOf,
  roundToHalfRupee,
  toPaise,
} from '../../shared/money';

/** Open Drizzle transaction handle. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export interface FareBreakdownInput {
  rideId: string;
  config: FareConfig;
  distanceKm: number;
  durationMin: number;
  /** Effective surge at booking time (price-locked), 1.0 = none. */
  surgeMultiplier: number;
  /** Intermediate stops beyond the final dropoff. */
  extraStops?: number;
  /** Total waiting minutes accrued across stops. */
  waitingMinutes?: number;
  tollPaise?: number;
  tipPaise?: number;
  promoDiscountPaise?: number;
  cancellationFeePaise?: number;
  /** Ride start time — decides the night surcharge. Defaults to now. */
  startedAt?: Date;
}

export interface FareBreakdown {
  basePaise: number;
  distancePaise: number;
  timePaise: number;
  surgePaise: number;
  waitingPaise: number;
  tollPaise: number;
  nightPaise: number;
  extraStopPaise: number;
  tipPaise: number;
  promoDiscountPaise: number;
  cancellationFeePaise: number;
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  driverEarningPaise: number;
  commissionPaise: number;
  surgeMultiplier: number;
}

/**
 * FareBreakdownService — turns a completed ride into an itemised, stored fare.
 *
 * Why store it rather than recompute on demand: `fare_configs` is ops-tunable,
 * so recomputing a three-month-old ride against today's rates produces a
 * different number than the rider paid. Every dispute then becomes
 * unwinnable. The breakdown is written once at completion and never
 * recalculated — it is a record, not a view.
 *
 * All arithmetic is in integer paise (AGENTS.md §2). The one place rupees
 * appear is reading the legacy `fare_configs` numeric columns, converted at
 * the boundary.
 *
 * Tax treatment: Indian ride fares are quoted TAX-INCLUSIVE. `totalPaise` is
 * what the rider pays; `taxPaise` is the GST already inside it, extracted by
 * InvoiceService. The breakdown therefore records taxPaise = 0 and leaves the
 * split to the invoice, so the two can never disagree about the total.
 */
@Injectable()
export class FareBreakdownService {
  private readonly logger = new Logger(FareBreakdownService.name);
  private readonly commissionPercent: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.commissionPercent = config.get<number>(
      'settlement.commissionPercent',
      20,
    );
  }

  /**
   * Compute the itemised fare. Pure — no I/O — so the arithmetic is directly
   * testable and callers can preview a fare without writing anything.
   *
   * Order is deliberate:
   *   1. metered components at 1× (base + distance + time)
   *   2. floor at the minimum fare — the floor applies BEFORE surge, otherwise
   *      a short surged trip is floored twice and the rider overpays
   *   3. apply surge, recording the uplift separately so a receipt can show it
   *   4. add non-surgeable extras (waiting, tolls, night, extra stops, tip):
   *      multiplying a toll or a tip by surge would be indefensible
   *   5. subtract promo, floor at zero
   */
  compute(input: FareBreakdownInput): FareBreakdown {
    const {
      config,
      distanceKm,
      durationMin,
      surgeMultiplier,
      extraStops = 0,
      waitingMinutes = 0,
      tollPaise = 0,
      tipPaise = 0,
      promoDiscountPaise = 0,
      cancellationFeePaise = 0,
      startedAt = new Date(),
    } = input;

    const safeDistanceKm = Math.max(0, distanceKm || 0);
    const safeDurationMin = Math.max(0, durationMin || 0);
    const effectiveSurge =
      Number.isFinite(surgeMultiplier) && surgeMultiplier > 0
        ? surgeMultiplier
        : 1;

    // 1. metered components at 1×
    const basePaise = toPaise(Number(config.baseFare));
    const distancePaise = toPaise(Number(config.perKmRate) * safeDistanceKm);
    const timePaise = toPaise(Number(config.perMinuteRate) * safeDurationMin);

    // 2. minimum-fare floor, pre-surge
    const meteredPaise = basePaise + distancePaise + timePaise;
    const minimumPaise = toPaise(Number(config.minimumFare));
    const flooredPaise = Math.max(meteredPaise, minimumPaise);

    // 3. surge uplift, recorded separately for the receipt
    const surgedPaise = roundToHalfRupee(flooredPaise * effectiveSurge);
    const surgePaise = Math.max(0, surgedPaise - flooredPaise);

    // 4. non-surgeable extras
    const chargeableWaitingMinutes = Math.max(
      0,
      Math.floor(waitingMinutes) - (config.freeWaitingMinutes ?? 0),
    );
    const waitingPaise = toPaise(
      Number(config.perWaitingMinuteFare ?? 0) * chargeableWaitingMinutes,
    );
    const extraStopPaise = toPaise(
      Number(config.perExtraStopFare ?? 0) *
        Math.max(0, Math.floor(extraStops)),
    );
    const nightPaise = this.isNightRide(config, startedAt)
      ? toPaise(Number(config.nightSurchargeFare ?? 0))
      : 0;

    const grossPaise =
      surgedPaise +
      waitingPaise +
      extraStopPaise +
      nightPaise +
      nonNegativePaise(tollPaise) +
      nonNegativePaise(tipPaise) +
      nonNegativePaise(cancellationFeePaise);

    // 5. promo, floored at zero — a discount larger than the fare makes the
    // ride free, never negative (we do not pay riders to travel).
    const cappedPromoPaise = Math.min(
      nonNegativePaise(promoDiscountPaise),
      grossPaise,
    );
    const totalPaise = Math.max(0, grossPaise - cappedPromoPaise);

    /**
     * Commission is charged on the platform's own revenue, NOT on the tip.
     * A tip is the rider's money for the driver; taking a cut of it is the
     * kind of thing that ends up in a news story.
     */
    const commissionableePaise = Math.max(
      0,
      totalPaise - nonNegativePaise(tipPaise),
    );
    const commissionPaise = percentOf(
      commissionableePaise,
      this.commissionPercent,
    );
    const driverEarningPaise = totalPaise - commissionPaise;

    return {
      basePaise,
      distancePaise,
      timePaise,
      surgePaise,
      waitingPaise,
      tollPaise: nonNegativePaise(tollPaise),
      nightPaise,
      extraStopPaise,
      tipPaise: nonNegativePaise(tipPaise),
      promoDiscountPaise: cappedPromoPaise,
      cancellationFeePaise: nonNegativePaise(cancellationFeePaise),
      // Subtotal is the pre-tax figure; tax is extracted from it by the
      // invoice, so subtotal === total here by construction.
      subtotalPaise: totalPaise,
      taxPaise: 0,
      totalPaise,
      driverEarningPaise,
      commissionPaise,
      surgeMultiplier: effectiveSurge,
    };
  }

  /**
   * Persist the breakdown for a ride. Idempotent by primary key — a retried
   * completion overwrites with the same values rather than failing, and the
   * ride keeps exactly one breakdown row.
   *
   * Accepts the caller's transaction so the breakdown commits with the
   * COMPLETED transition that produced it.
   */
  async persist(
    rideId: string,
    breakdown: FareBreakdown,
    fareConfigId: string | null,
    tx?: Tx,
  ): Promise<void> {
    const exec = tx ?? this.db;
    const values = {
      rideId,
      basePaise: breakdown.basePaise,
      distancePaise: breakdown.distancePaise,
      timePaise: breakdown.timePaise,
      surgePaise: breakdown.surgePaise,
      waitingPaise: breakdown.waitingPaise,
      tollPaise: breakdown.tollPaise,
      nightPaise: breakdown.nightPaise,
      extraStopPaise: breakdown.extraStopPaise,
      tipPaise: breakdown.tipPaise,
      promoDiscountPaise: breakdown.promoDiscountPaise,
      cancellationFeePaise: breakdown.cancellationFeePaise,
      subtotalPaise: breakdown.subtotalPaise,
      taxPaise: breakdown.taxPaise,
      totalPaise: breakdown.totalPaise,
      driverEarningPaise: breakdown.driverEarningPaise,
      commissionPaise: breakdown.commissionPaise,
      surgeMultiplier: breakdown.surgeMultiplier,
      fareConfigId,
    };

    await exec.insert(rideFareBreakdown).values(values).onConflictDoUpdate({
      target: rideFareBreakdown.rideId,
      set: values,
    });
  }

  /** The stored breakdown for a ride, or null if none was written. */
  async getForRide(rideId: string): Promise<FareBreakdown | null> {
    const [row] = await this.db
      .select()
      .from(rideFareBreakdown)
      .where(eq(rideFareBreakdown.rideId, rideId))
      .limit(1);
    if (!row) return null;
    return {
      basePaise: row.basePaise,
      distancePaise: row.distancePaise,
      timePaise: row.timePaise,
      surgePaise: row.surgePaise,
      waitingPaise: row.waitingPaise,
      tollPaise: row.tollPaise,
      nightPaise: row.nightPaise,
      extraStopPaise: row.extraStopPaise,
      tipPaise: row.tipPaise,
      promoDiscountPaise: row.promoDiscountPaise,
      cancellationFeePaise: row.cancellationFeePaise,
      subtotalPaise: row.subtotalPaise,
      taxPaise: row.taxPaise,
      totalPaise: row.totalPaise,
      driverEarningPaise: row.driverEarningPaise,
      commissionPaise: row.commissionPaise,
      surgeMultiplier: Number(row.surgeMultiplier),
    };
  }

  /**
   * Night-window test. Handles a window that wraps midnight (23 → 5), which
   * is the normal shape for a night surcharge and the case a naive
   * `hour >= start && hour < end` comparison gets silently wrong.
   */
  private isNightRide(config: FareConfig, at: Date): boolean {
    if (Number(config.nightSurchargeFare ?? 0) <= 0) return false;
    const hour = at.getHours();
    const start = config.nightStartHour ?? 23;
    const end = config.nightEndHour ?? 5;
    return start <= end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
  }
}
