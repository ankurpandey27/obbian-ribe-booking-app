import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomInt } from 'crypto';
import { Ride } from './entities/ride.entity';
import { RideStateMachine } from './state-machine/ride-state-machine';
import { OutboxService } from '../../common/events/outbox.service';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { rides as ridesTable } from '../../common/database/schema';
import { TOPICS } from '../../shared/events/topics';
import { RideEventType } from '../../shared/events/contracts';
import { QUEUE_MATCHING } from '../../common/queues/queues.module';
import { PricingService } from '../pricing/pricing.service';
import { SurgeService } from '../pricing/surge.service';
import { FareBreakdownService } from '../pricing/fare-breakdown.service';
import { InvoiceService } from '../pricing/invoice.service';
import { GeoService } from '../../common/redis/geo.service';
import { PromosService } from '../promos/promos.service';
import { FraudService } from './fraud.service';
import { RideStopsService } from './ride-stops.service';
import { DriversService } from '../drivers/drivers.service';
import { WalletLedgerService } from '../payments/wallet-ledger.service';
import { InjectRedis } from '../../common/redis/redis.decorator';
import type Redis from 'ioredis';
import { CatalogService } from '../catalog/catalog.service';

/**
 * Pickup proximity fence (meters). A driver must be within this radius of the
 * ride's pickup point to mark themselves arrived and generate a boarding code.
 * Prevents a driver from minting a code (and appearing "arrived") while still
 * far from the rider. ~200m balances GPS jitter against a meaningful distance.
 */
const PICKUP_ARRIVAL_RADIUS_M = 200;
import {
  CancellationReasonValue,
  RideStatusValue,
} from '../../shared/types/common';
import { toPaise, toRupees } from '../../shared/money';
import { MetricsService } from '../../common/observability/metrics.service';
import { CancellationPenaltiesService } from '../ops/cancellation-penalties.service';
import { DriverIncentivesService } from '../growth/driver-incentives.service';
import { ReferralsService } from '../growth/referrals.service';

/** Open Drizzle transaction handle. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export interface RequestRideInput {
  riderId: string;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
  rideType: string;
  city: string;
  estimatedFare: number;
  distanceKm: number;
  durationMin: number;
  surgeMultiplier: number;
  promoCode?: string;
  promoDiscount?: number;
  stops?: Array<{ lat: number; lon: number; address?: string }>;
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
    @InjectRedis() private readonly redis: Redis,
    private readonly geo: GeoService,
    private readonly moduleRef: ModuleRef,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingService,
    private readonly drivers: DriversService,
    private readonly fraudService: FraudService,
    private readonly promos: PromosService,
    private readonly surge: SurgeService,
    private readonly fareBreakdown: FareBreakdownService,
    private readonly invoices: InvoiceService,
    private readonly rideStops: RideStopsService,
    private readonly ledger: WalletLedgerService,
    private readonly penalties: CancellationPenaltiesService,
    private readonly incentives: DriverIncentivesService,
    private readonly referrals: ReferralsService,
    private readonly catalog: CatalogService,
    @InjectQueue(QUEUE_MATCHING) private readonly matchingQueue: Queue,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Pickup verification (Uber/Rapido-style boarding code).
   *
   * A short numeric code generated when the driver arrives. The rider reads
   * it out to the driver; the driver must enter it to start the trip. This
   * proves the rider is physically present before the ride begins.
   *
   * Stored in Redis (ephemeral, TTL) — never persisted to the rides table,
   * so a code can't outlive its ride. One-time use: cleared on successful
   * verification or after max failed attempts.
   */
  private static readonly BOARDING_CODE_PREFIX = 'ride:boarding:';
  private static readonly BOARDING_CODE_TTL_SEC = 600; // 10 min
  private static readonly BOARDING_CODE_ATTEMPTS_SUFFIX = ':attempts';
  private static readonly BOARDING_MAX_ATTEMPTS = 5;
  private static readonly BOARDING_CODE_MIN = 1000;
  private static readonly BOARDING_CODE_MAX = 9999;

  private boardingCodeKey(rideId: string): string {
    return `${RidesService.BOARDING_CODE_PREFIX}${rideId}`;
  }

  private boardingAttemptsKey(rideId: string): string {
    return `${RidesService.BOARDING_CODE_PREFIX}${rideId}${RidesService.BOARDING_CODE_ATTEMPTS_SUFFIX}`;
  }

  /** Crypto-secure 4-digit boarding code. */
  static generateBoardingCode(): string {
    return String(
      randomInt(
        RidesService.BOARDING_CODE_MIN,
        RidesService.BOARDING_CODE_MAX + 1,
      ),
    );
  }

  private async storeBoardingCode(rideId: string, code: string): Promise<void> {
    const key = this.boardingCodeKey(rideId);
    await this.redis.set(key, code, 'EX', RidesService.BOARDING_CODE_TTL_SEC);
    await this.redis.del(this.boardingAttemptsKey(rideId));
  }

  /**
   * Verify the driver-supplied boarding code and consume it on success.
   * Returns the outcome so the caller can map it to the right HTTP status.
   */
  async verifyBoardingCode(
    rideId: string,
    code: string,
  ): Promise<{
    ok: boolean;
    reason?: 'NO_CODE' | 'EXPIRED' | 'WRONG' | 'EXHAUSTED';
  }> {
    const key = this.boardingCodeKey(rideId);
    const stored = await this.redis.get(key);
    if (!stored) {
      // No active code — either never generated or already consumed/expired.
      return { ok: false, reason: 'NO_CODE' };
    }

    const attempts = await this.redis.incr(this.boardingAttemptsKey(rideId));
    if (attempts > RidesService.BOARDING_MAX_ATTEMPTS) {
      await this.redis.del(key);
      await this.redis.del(this.boardingAttemptsKey(rideId));
      return { ok: false, reason: 'EXHAUSTED' };
    }

    if (stored !== code) {
      return { ok: false, reason: 'WRONG' };
    }

    // Success — one-time use.
    await this.redis.del(key);
    await this.redis.del(this.boardingAttemptsKey(rideId));
    return { ok: true };
  }

  /** Clear any active boarding code (ride cancelled before pickup). */
  async clearBoardingCode(rideId: string): Promise<void> {
    await this.redis.del(this.boardingCodeKey(rideId));
    await this.redis.del(this.boardingAttemptsKey(rideId));
  }

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
      rideType: string;
      city?: string;
      promoCode?: string;
      stops?: Array<{ lat: number; lon: number; address?: string }>;
    },
  ): Promise<{
    ride: Ride;
    surgeMultiplier: number;
    promoDiscount: number;
    estimatedTime: number | undefined;
  }> {
    const city = dto.city ?? 'Delhi';

    // CATALOG VALIDATION: rideType is no longer an enum — validate it against
    // the active catalog for the request city. Rejects unknown/inactive codes.
    const activeCodes = await this.catalog.getActiveCategoryCodes(city);
    if (!activeCodes.includes(dto.rideType)) {
      throw new BadRequestException(
        `Unknown or unavailable ride category '${dto.rideType}' for city ${city}. Active: ${activeCodes.join(', ')}`,
      );
    }

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
        stops: dto.stops,
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
    const { stops, ...rideInput } = input;
    const ride = await this.db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(ridesTable)
        .values({ ...rideInput, status: 'REQUESTED' })
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

    if (stops?.length) {
      await this.rideStops.addStops(ride.id, stops, input.riderId);
    }

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

  async listStops(rideId: string) {
    return this.rideStops.list(rideId);
  }

  async addStops(
    rideId: string,
    riderId: string,
    stops: Array<{ lat: number; lon: number; address?: string }>,
  ) {
    return this.rideStops.addStops(rideId, stops, riderId);
  }

  async arriveStop(rideId: string, stopId: string, driverId: string) {
    return this.rideStops.markArrived(rideId, stopId, driverId);
  }

  async departStop(rideId: string, stopId: string, driverId: string) {
    return this.rideStops.markDeparted(rideId, stopId, driverId);
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
    // One transaction: conditional state update + durable outbox event.
    return this.db.transaction((tx) =>
      this.transitionInTx(tx, ride, to, patch, eventType),
    );
  }

  /**
   * Transition inside an EXISTING transaction.
   *
   * Extracted so completion can commit the state change together with the
   * artefacts that describe it (breakdown, invoice, ledger). Callers that only
   * need the transition use `transition()` above.
   *
   * The update is keyed on the OBSERVED status — two concurrent transitions
   * race on the DB row, exactly one wins, the loser gets a Conflict instead of
   * silently double-applying (AGENTS.md §4).
   */
  private async transitionInTx(
    tx: Tx,
    ride: Ride,
    to: RideStatusValue,
    patch: Partial<Ride> = {},
    eventType = `RIDE_${to}`,
  ): Promise<Ride> {
    RideStateMachine.assertTransition(ride.status, to);

    const [updated] = await tx
      .update(ridesTable)
      .set({ ...patch, status: to, updatedAt: new Date() })
      .where(
        and(eq(ridesTable.id, ride.id), eq(ridesTable.status, ride.status)),
      )
      .returning();

    if (!updated) {
      this.metrics?.recordRideTransitionConflict(ride.status, to);
      throw new ConflictException(
        `Ride ${ride.id} changed concurrently (was ${ride.status})`,
      );
    }

    this.metrics?.recordRideTransition(ride.status, to);

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
  }

  /**
   * Driver arrived at pickup point. Generates a one-time boarding code the
   * rider reads to the driver.
   *
   * GEO-FENCE: the driver must be within PICKUP_ARRIVAL_RADIUS_M of the ride's
   * pickup coordinates. Prevents a driver from marking arrived (and minting a
   * code) while still far from the rider. Uses the driver's last cached position
   * in Redis (written on every location ping). If no position is cached yet
   * (e.g. brand-new driver who never pinged), the check is skipped rather than
   * blocking — the boarding code + rider-speaks-it model is the second guard.
   */
  async driverArrive(rideId: string): Promise<Ride> {
    const ride = await this.getRide(rideId);
    // GEO-FENCE: must hold on every call, including re-arrive (code rotation).
    await this.assertDriverIsAtPickup(ride);

    // RECOVERY: if already ARRIVED (driver exhausted/expired their boarding
    // code), rotate the code instead of failing the transition — ARRIVED →
    // ARRIVED is not a valid state-machine edge, so a naive transition would
    // brick the ride. Re-running the geo-fence here is intentional: a driver
    // who left the pickup area and comes back must prove proximity again.
    if (ride.status === 'ARRIVED') {
      const code = RidesService.generateBoardingCode();
      await this.storeBoardingCode(rideId, code);
      return ride;
    }

    const arrived = await this.transition(rideId, 'ARRIVED', {
      arrivedAt: new Date(),
    });
    const code = RidesService.generateBoardingCode();
    await this.storeBoardingCode(rideId, code);
    return arrived;
  }

  /** Haversine distance in metres between two lat/lon points. */
  private haversineM(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000; // earth radius in metres
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Verify the assigned driver is physically near the pickup point. Read-only
   * (no state change) so it can safely precede the ARRIVED transition.
   */
  private async assertDriverIsAtPickup(ride: Ride): Promise<void> {
    if (!ride.driverId) return; // not yet assigned — let the transition reject
    const pos = await this.geo.getDriverPosition(ride.driverId);
    if (!pos) return; // no cached position — skip, boarding code is the guard
    const distM = this.haversineM(
      pos.lat,
      pos.lon,
      ride.pickupLat,
      ride.pickupLon,
    );
    if (distM > PICKUP_ARRIVAL_RADIUS_M) {
      throw new ForbiddenException(
        `Driver is ${Math.round(
          distM,
        )}m from pickup (max ${PICKUP_ARRIVAL_RADIUS_M}m). Move closer before marking arrived.`,
      );
    }
  }

  /** Read the active boarding code (for the rider to display). */
  async getBoardingCode(rideId: string): Promise<string | null> {
    return this.redis.get(this.boardingCodeKey(rideId));
  }

  /** Remaining TTL (seconds) of the active boarding code. */
  async getBoardingCodeTtl(rideId: string): Promise<number> {
    return this.redis.ttl(this.boardingCodeKey(rideId));
  }

  /** Driver started the trip — requires the rider-supplied boarding code. */
  async driverStart(
    rideId: string,
    code: string,
  ): Promise<{ ride: Ride; codeResult: { ok: boolean; reason?: string } }> {
    const result = await this.verifyBoardingCode(rideId, code);
    if (!result.ok) {
      throw new ForbiddenException(
        result.reason === 'EXHAUSTED'
          ? 'Too many attempts. Driver must re-arrive to get a new code.'
          : result.reason === 'WRONG'
            ? 'Invalid boarding code. Ask the rider for the current code.'
            : 'No active boarding code. Driver must re-arrive.',
      );
    }
    const ride = await this.transition(rideId, 'IN_PROGRESS', {
      startedAt: new Date(),
    });
    return { ride, codeResult: result };
  }

  /**
   * Driver completed the trip.
   *
   * Everything that describes the money for this ride commits in ONE
   * transaction: the COMPLETED transition, its outbox event, the itemised fare
   * breakdown, the GST invoice, and the driver's ledger credit. A ride that is
   * COMPLETED but has no receipt — or a receipt with no matching earning — is
   * an unreconcilable state, so partial commits are not allowed (ADR-014).
   *
   * The final fare comes from the road config plus recorded extras, not from
   * the estimate: waiting time and stops are only known once the trip ends.
   */
  async completeRide(rideId: string): Promise<Ride> {
    const ride = await this.getRide(rideId);
    if (ride.status === 'COMPLETED') {
      // Idempotent: a retried completion returns the settled ride rather than
      // re-crediting the driver.
      return ride;
    }

    const config = await this.pricing.getConfig(ride.city, ride.rideType);
    const stopSummary = await this.rideStops.summarise(rideId);

    const breakdown = this.fareBreakdown.compute({
      rideId,
      config,
      distanceKm: Number(ride.distanceKm),
      durationMin: ride.durationMin,
      surgeMultiplier: Number(ride.surgeMultiplier),
      extraStops: stopSummary.extraStops,
      waitingMinutes: stopSummary.waitingMinutes,
      promoDiscountPaise: toPaise(Number(ride.promoDiscount) || 0),
      startedAt: ride.startedAt ?? new Date(),
    });

    const totalFare = toRupees(breakdown.totalPaise);
    this.metrics?.recordRideFare(ride.rideType, breakdown.totalPaise);

    const completed = await this.db.transaction(async (tx) => {
      const updated = await this.transitionInTx(
        tx,
        ride,
        'COMPLETED',
        { totalFare, completedAt: new Date() },
        'RIDE_COMPLETED',
      );

      await this.fareBreakdown.persist(rideId, breakdown, config.id, tx);

      await this.invoices.issueForRide(
        {
          rideId,
          grossPaise: breakdown.totalPaise,
          // City, not a state code — InvoiceService owns the city→state
          // mapping that decides CGST+SGST vs IGST.
          city: ride.city,
        },
        tx,
      );

      // Driver earning + platform commission as two ledger entries, so the
      // gross the rider paid and the cut taken are both visible in an audit.
      if (ride.driverId && breakdown.totalPaise > 0) {
        await this.ledger.writeMany(
          [
            {
              driverId: ride.driverId,
              entryType: 'RIDE_EARNING',
              amountPaise: breakdown.totalPaise,
              idempotencyKey: `ride:${rideId}:earning`,
              referenceType: 'ride',
              referenceId: rideId,
            },
            ...(breakdown.commissionPaise > 0
              ? ([
                  {
                    driverId: ride.driverId,
                    entryType: 'COMMISSION_DEBIT' as const,
                    amountPaise: breakdown.commissionPaise,
                    idempotencyKey: `ride:${rideId}:commission`,
                    referenceType: 'ride',
                    referenceId: rideId,
                  },
                ] as const)
              : []),
          ],
          tx,
        );
        await this.incentives.recordRideCompletion(
          ride.driverId,
          breakdown.totalPaise,
          tx,
        );
      }

      await this.referrals.recordQualifyingRide(ride.riderId, rideId, tx);

      return updated;
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

    // PENALTY BYPASS GUARD: 'SYSTEM' must never arrive from a client. Only the
    // server sets SYSTEM (e.g. automated no-driver timeout). Accepting it from
    // the client would let a rider/driver cancel without paying the fee.
    if (cancelledBy === 'SYSTEM') {
      throw new ForbiddenException('Invalid cancellation source');
    }

    const penalty = await this.penalties.evaluate(
      cancelledBy === 'DRIVER' ? (ride.driverId ?? '') : ride.riderId,
      cancelledBy,
      ride.createdAt,
    );
    const fee = toRupees(penalty.penaltyPaise);

    const cancelled = await this.db.transaction(async (tx) => {
      const updated = await this.transitionInTx(
        tx,
        ride,
        'CANCELLED',
        {
          cancellationReason: reason,
          cancellationFee: fee,
          cancelledAt: new Date(),
        },
        'RIDE_CANCELLED',
      );
      // Only record a penalty when the cancelling party is a real user role.
      // SYSTEM cancellations (server-side) carry no penalty.
      if (cancelledBy === 'RIDER' || cancelledBy === 'DRIVER') {
        await this.penalties.record(
          {
            userId:
              cancelledBy === 'DRIVER' ? (ride.driverId ?? '') : ride.riderId,
            rideId,
            role: cancelledBy,
            reason,
            createdAt: ride.createdAt,
            driverId: ride.driverId ?? undefined,
          },
          tx,
          penalty,
        );
      }
      return updated;
    });

    // Ride won't start — drop any active boarding code so it can't be reused.
    await this.clearBoardingCode(rideId);

    // Auto-refund: if the ride was paid, trigger a refund through the payment
    // gateway. Lazy-resolved via ModuleRef to avoid a module cycle (payments
    // already imports rides). Best-effort: a failed refund must not fail the
    // cancel — it is logged and surfaced for ops intervention.
    let refundAmount = 0;
    if (cancelled.paymentStatus === 'COMPLETED') {
      try {
        // ModuleRef.get with a string token resolves the singleton from the
        // root context — works across the module boundary without a cycle.
        // String token avoids a circular file import (rides <-> payments).
        const payments = this.moduleRef.get('PAYMENTS_SERVICE', {
          strict: false,
        });
        if (payments) {
          // refund() returns the actual disbursed amount — single source of
          // truth. On success it is the captured payment amount; on idempotent
          // replay (already refunded) it is 0. This guarantees the reported
          // refundAmount always matches the money the gateway moved, with no
          // recomputed estimate that could diverge.
          const result = await (
            payments as {
              refund(
                rideId: string,
              ): Promise<{ refunded: boolean; amount: number }>;
            }
          ).refund(rideId);
          refundAmount = result?.amount ?? 0;
        }
      } catch (err) {
        this.logger.error(
          `auto-refund failed for cancelled ride ${rideId}: ${String(err)}`,
        );
      }
    }

    return {
      ride: cancelled,
      // Refund amount is exactly what payment gateway returned — never a
      // recomputed estimate. 0 when no payment captured or refund is a replay.
      refundAmount,
    };
  }
}
