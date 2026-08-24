import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Ride } from '../entities/ride.entity';
import { RideStateMachine } from '../state-machine/ride-state-machine';
import { OutboxService } from '../../../common/events/outbox.service';
import { DRIZZLE_DB, DrizzleDB } from '../../../common/database/drizzle.module';
import { rides as ridesTable } from '../../../common/database/schema';
import { TOPICS } from '../../../shared/events/topics';
import { RideEventType } from '../../../shared/events/contracts';
import { QUEUE_MATCHING } from '../../../common/queues/queues.module';
import { PricingService } from '../../pricing/services/pricing.service';
import { SurgeService } from '../../pricing/services/surge.service';
import { PromosService } from '../../promos/services/promos.service';
import { FraudService } from './fraud.service';
import { DriversService } from '../../drivers/services/drivers.service';
import {
  CancellationReasonValue,
  RideStatusValue,
  RideTypeValue,
} from '../../../shared/types/common';

export interface RequestRideInput {
  riderId: string;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
  rideType: RideTypeValue;
  city: string;
  estimatedFare: number;
  distanceKm: number;
  durationMin: number;
  surgeMultiplier: number;
  promoCode?: string;
  promoDiscount?: number;
}

/**
 * RidesService — ride lifecycle owner. Every transition goes through
 * the state machine and is committed together with its outbox event
 * (atomic durability — no state change can exist without its event).
 */
@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingService,
    private readonly drivers: DriversService,
    private readonly fraudService: FraudService,
    private readonly promos: PromosService,
    private readonly surge: SurgeService,
    @InjectQueue(QUEUE_MATCHING) private readonly matchingQueue: Queue,
  ) {}

  /**
   * Full ride-request use case: fraud guard → quote → price lock →
   * promo claim → create + outbox. Owns ALL request orchestration so the
   * controller stays thin (Nest style rule: no business logic there).
   */
  async requestRide(
    riderId: string,
    dto: {
      pickupLat: number;
      pickupLon: number;
      dropoffLat: number;
      dropoffLon: number;
      rideType: RideTypeValue;
      city?: string;
      promoCode?: string;
    },
  ): Promise<{
    ride: Ride;
    surgeMultiplier: number;
    promoDiscount: number;
    estimatedTime: number | undefined;
  }> {
    const city = dto.city ?? 'Delhi';

    // Fraud guard, fare config and route quote are independent — fan out.
    const [config, quote] = await Promise.all([
      this.pricing.getConfig(city, dto.rideType),
      this.pricing.getQuote(
        dto.pickupLat,
        dto.pickupLon,
        dto.dropoffLat,
        dto.dropoffLon,
        city,
        [dto.rideType],
      ),
      this.fraudService.guardRideRequest(
        riderId,
        dto.pickupLat,
        dto.pickupLon,
        city,
      ),
    ]);

    const estimatedFare = this.pricing.calculateFare(
      config,
      quote.distanceKm,
      quote.durationMin,
    );
    // Price lock = what the client saw in the quote (surge included).
    const quotedOption = quote.options.find((o) => o.rideType === dto.rideType);
    const lockedFare =
      quotedOption && quote.surgeMultiplier ? quotedOption.fare : estimatedFare;

    let promoDiscount = 0;
    if (dto.promoCode) {
      const promo = await this.promos.redeem(dto.promoCode, riderId);
      promoDiscount = Math.min(
        Math.round(((lockedFare * promo.discountPercent) / 100) * 2) / 2,
        promo.maxDiscount,
      );
    }

    let ride: Ride;
    try {
      ride = await this.createRide({
        riderId,
        pickupLat: dto.pickupLat,
        pickupLon: dto.pickupLon,
        dropoffLat: dto.dropoffLat,
        dropoffLon: dto.dropoffLon,
        rideType: dto.rideType,
        city,
        estimatedFare: lockedFare,
        distanceKm: quote.distanceKm,
        durationMin: Math.max(0, Math.round(quote.durationMin ?? 0)),
        surgeMultiplier:
          quote.surgeMultiplier ?? Number(config.surgeMultiplier),
        promoCode: dto.promoCode,
        promoDiscount,
      });
    } catch (err) {
      if (dto.promoCode) {
        await this.promos
          .release(dto.promoCode, riderId)
          .catch(() => undefined);
      }
      throw err;
    }

    void this.surge
      .recordDemand(city, dto.pickupLat, dto.pickupLon)
      .catch(() => undefined);

    return {
      ride,
      surgeMultiplier: Number(ride.surgeMultiplier),
      promoDiscount,
      estimatedTime: quote.durationMin,
    };
  }

  async createRide(input: RequestRideInput): Promise<Ride> {
    const ride = await this.db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(ridesTable)
        .values({ ...input, status: 'REQUESTED' })
        .returning();
      await this.outbox.write(tx, {
        topic: TOPICS.RIDE_EVENTS,
        type: RideEventType.RIDE_REQUESTED,
        aggregateType: 'ride',
        aggregateId: saved.id,
        payload: {
          rideId: saved.id,
          riderId: saved.riderId,
          status: saved.status,
          rideType: saved.rideType,
          occurredAt: new Date().toISOString(),
        },
      });
      return saved;
    });

    // Kick off driver dispatch off the HTTP path. jobId = idempotent per ride.
    await this.matchingQueue
      .add('match', { rideId: ride.id }, { jobId: `match-${ride.id}` })
      .catch((err) =>
        this.logger.error(
          `matching enqueue failed for ${ride.id}`,
          err.message,
        ),
      );
    return ride;
  }

  async getRide(rideId: string): Promise<Ride> {
    const [ride] = await this.db
      .select()
      .from(ridesTable)
      .where(eq(ridesTable.id, rideId))
      .limit(1);
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);
    return ride;
  }

  async getActiveRidesForRider(riderId: string): Promise<Ride[]> {
    return this.db
      .select()
      .from(ridesTable)
      .where(
        and(
          eq(ridesTable.riderId, riderId),
          inArray(ridesTable.status, [
            'REQUESTED',
            'MATCHING',
            'ACCEPTED',
            'ARRIVED',
            'IN_PROGRESS',
          ]),
        ),
      )
      .orderBy(sql`${ridesTable.createdAt} DESC`);
  }

  async getActiveRideForDriver(driverId: string): Promise<Ride | null> {
    const [ride] = await this.db
      .select()
      .from(ridesTable)
      .where(
        and(
          eq(ridesTable.driverId, driverId),
          inArray(ridesTable.status, ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS']),
        ),
      )
      .limit(1);
    return ride ?? null;
  }

  async getHistoryForRider(
    riderId: string,
    limit = 20,
    offset = 0,
  ): Promise<Ride[]> {
    return this.db
      .select()
      .from(ridesTable)
      .where(
        and(
          eq(ridesTable.riderId, riderId),
          eq(ridesTable.status, 'COMPLETED'),
        ),
      )
      .orderBy(sql`${ridesTable.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
  }

  async transition(
    rideId: string,
    to: RideStatusValue,
    patch: Partial<Ride> = {},
    eventType = `RIDE_${to}`,
  ): Promise<Ride> {
    const ride = await this.getRide(rideId);
    RideStateMachine.assertTransition(ride.status, to);

    // One transaction: conditional state update + durable outbox event.
    // The update is keyed on the observed status — two concurrent
    // transitions race on the DB row, exactly one wins, the loser gets a
    // Conflict instead of silently double-applying.
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ridesTable)
        .set({ ...patch, status: to, updatedAt: new Date() })
        .where(
          and(eq(ridesTable.id, rideId), eq(ridesTable.status, ride.status)),
        )
        .returning();

      if (!updated) {
        throw new ConflictException(
          `Ride ${rideId} changed concurrently (was ${ride.status})`,
        );
      }

      await this.outbox.write(tx, {
        topic: TOPICS.RIDE_EVENTS,
        type: eventType,
        aggregateType: 'ride',
        aggregateId: updated.id,
        payload: {
          rideId: updated.id,
          riderId: updated.riderId,
          driverId: updated.driverId,
          status: updated.status,
          rideType: updated.rideType,
          totalFare: updated.totalFare ?? undefined,
          cancellationReason: updated.cancellationReason,
          cancellationFee: Number(updated.cancellationFee),
          occurredAt: new Date().toISOString(),
        },
      });
      return updated;
    });
  }

  /** Driver arrived at pickup point. */
  async driverArrive(rideId: string): Promise<Ride> {
    return this.transition(rideId, 'ARRIVED', { arrivedAt: new Date() });
  }

  /** Driver started the trip. */
  async driverStart(rideId: string): Promise<Ride> {
    return this.transition(rideId, 'IN_PROGRESS', { startedAt: new Date() });
  }

  /** Driver completed the trip — final fare from road config, not estimate. */
  async completeRide(rideId: string): Promise<Ride> {
    const ride = await this.getRide(rideId);
    const config = await this.pricing.getConfig(ride.city, ride.rideType);
    const fare = this.pricing.calculateFare(
      config,
      Number(ride.distanceKm),
      ride.durationMin,
    );
    // Promo discount applied at completion against the final fare.
    const discount = Number(ride.promoDiscount) || 0;
    const totalFare = Math.max(0, fare - discount);
    const completed = await this.transition(rideId, 'COMPLETED', {
      totalFare,
      completedAt: new Date(),
    });

    // Driver back ONLINE + matchable at pickup. Self-healing side effect —
    // must not add latency to the driver's completion response.
    if (ride.driverId) {
      void this.drivers
        .completeRide(ride.driverId, ride.pickupLat, ride.pickupLon)
        .catch((err) =>
          this.logger.error(
            `driver restore failed for ${ride.driverId}`,
            err.message,
          ),
        );
    }
    return completed;
  }

  /** Rider or driver cancellation with fee rules. */
  async cancel(
    rideId: string,
    reason: CancellationReasonValue,
    cancelledBy: 'RIDER' | 'DRIVER' | 'SYSTEM',
  ): Promise<{ ride: Ride; refundAmount: number }> {
    const ride = await this.getRide(rideId);
    if (!RideStateMachine.canCancel(ride.status)) {
      throw new BadRequestException(
        `Ride in state ${ride.status} cannot be cancelled`,
      );
    }

    let fee = 0;
    if (cancelledBy === 'RIDER') {
      const minutesSinceRequest =
        (Date.now() - ride.createdAt.getTime()) / 60000;
      fee = minutesSinceRequest > 2 ? 50 : 0; // free within 2 min, ₹50 after
    } else if (cancelledBy === 'DRIVER') {
      fee = 50; // driver-initiated cancellation fine
    }

    const cancelled = await this.transition(
      rideId,
      'CANCELLED',
      {
        cancellationReason: reason,
        cancellationFee: fee,
        cancelledAt: new Date(),
      },
      'RIDE_CANCELLED',
    );

    return {
      ride: cancelled,
      refundAmount: Number(cancelled.estimatedFare) - fee,
    };
  }
}
