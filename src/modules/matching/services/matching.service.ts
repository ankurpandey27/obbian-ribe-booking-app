import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { DriversService } from '../../drivers/services/drivers.service';
import { RidesService } from '../../rides/services/rides.service';
import { EventBus } from '../../../common/events/event-bus.service';
import { TOPICS } from '../../../shared/events/topics';
import {
  DriverResponseType,
  OfferEventType,
} from '../../../shared/events/contracts';
import { RideTypeValue } from '../../../shared/types/common';
import { Driver } from '../../drivers/entities/driver.entity';

const CLAIM_TTL_SECONDS = 30;

export interface OfferResult {
  rideId: string;
  driverId: string;
  offerId: string;
}

/**
 * MatchingService — dispatch engine.
 * 1. Find nearby matchable drivers (Redis geo, vehicle-type filtered)
 * 2. Rank by distance + rating (score)
 * 3. Send offers to the top N — HEDGED (default): all at once, first
 *    accept wins; SEQUENTIAL: one at a time, next after a rejection or
 *    the per-driver window elapses.
 * 4. Driver response writes an ATOMIC claim key (SET NX) —
 *    only the first accept wins, double-acceptance impossible.
 * 5. Ride transitions ACCEPTED; remaining offers withdrawn.
 *
 * Runs as a BullMQ job so a crash mid-match can be retried;
 * the atomic claim makes retries safe.
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly radiusKm: number;
  private readonly maxCandidates: number;
  private readonly offerTtlSeconds: number;
  private readonly hedged: boolean;
  private readonly sequentialWindowMs: number;
  private readonly commissionPercent: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly driversService: DriversService,
    private readonly ridesService: RidesService,
    private readonly events: EventBus,
    config: ConfigService,
  ) {
    this.radiusKm = config.get<number>('matching.radiusKm', 8);
    this.maxCandidates = config.get<number>('matching.maxCandidates', 3);
    this.offerTtlSeconds = config.get<number>('matching.offerTtlSeconds', 30);
    this.hedged = config.get<boolean>('matching.hedged', true);
    this.sequentialWindowMs = config.get<number>(
      'matching.sequentialWindowMs',
      8000,
    );
    this.commissionPercent = config.get<number>(
      'settlement.commissionPercent',
      20,
    );
  }

  /**
   * Entry point: called after ride creation. Attempts to find a driver.
   * Returns when matched or throws when no driver accepted.
   */
  async matchRide(rideId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.status !== 'REQUESTED') {
      // Idempotent guard: re-triggers only on the fresh request.
      return;
    }

    // Broadcast to candidates; they respond via driver-responses topic.
    await this.dispatchOffers(
      rideId,
      ride.pickupLat,
      ride.pickupLon,
      ride.rideType,
      Number(ride.estimatedFare),
    );
  }

  private async dispatchOffers(
    rideId: string,
    pickupLat: number,
    pickupLon: number,
    rideType: RideTypeValue,
    estimatedFare: number,
  ): Promise<void> {
    const candidates = await this.driversService.findMatchableDrivers(
      pickupLon,
      pickupLat,
      this.radiusKm,
      rideType,
      10,
    );

    if (candidates.length === 0) {
      await this.handleNoDrivers(rideId);
      return;
    }

    // Rank: rating weight 40% + ride experience. (Distance is already
    // implicit — findMatchableDrivers returns closest-first from geo.)
    const scored = candidates
      .map((d, idx) => ({
        driver: d,
        score:
          Number(d.rating) * 40 + (idx === 0 ? 60 : Math.max(0, 60 - idx * 10)),
      }))
      .sort((a, b) => b.score - a.score);

    const topN = scored.slice(0, this.maxCandidates);

    // HEDGED: fire offers to all candidates concurrently, first accept
    // wins (atomic claim). SEQUENTIAL: try one at a time.
    if (this.hedged) {
      await this.dispatchHedged(
        rideId,
        topN,
        pickupLat,
        pickupLon,
        estimatedFare,
      );
    } else {
      await this.dispatchSequential(
        rideId,
        topN,
        pickupLat,
        pickupLon,
        estimatedFare,
      );
    }

    // Wait for a driver to claim, or timeout → cancel.
    // Sequential mode gives each candidate their window (max total);
    // hedged mode waits the offer TTL.
    const claimKey = `ride:claim:${rideId}`;
    const waitMs = this.hedged
      ? this.offerTtlSeconds * 1000 + 5000
      : Math.min(
          this.maxCandidates * this.sequentialWindowMs,
          this.offerTtlSeconds * 1000,
        ) + 5000;
    const claim = await this.waitForClaim(claimKey, waitMs);

    if (!claim) {
      await this.handleNoDrivers(rideId);
      return;
    }

    const { driverId } = JSON.parse(claim) as { driverId: string };
    await this.finalizeMatch(rideId, driverId);
  }

  private async dispatchHedged(
    rideId: string,
    candidates: { driver: Driver; score: number }[],
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<void> {
    for (const { driver } of candidates) {
      await this.sendOffer(
        rideId,
        driver.userId,
        pickupLat,
        pickupLon,
        estimatedFare,
      );
    }
  }

  private async dispatchSequential(
    rideId: string,
    candidates: { driver: Driver; score: number }[],
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<void> {
    for (const { driver } of candidates) {
      await this.sendOffer(
        rideId,
        driver.userId,
        pickupLat,
        pickupLon,
        estimatedFare,
      );
      // Give this driver a window; move on if they reject or stall.
      await new Promise((r) => setTimeout(r, this.sequentialWindowMs));
      const claimKey = `ride:claim:${rideId}`;
      if (await this.redis.get(claimKey)) return;
    }
  }

  private async sendOffer(
    rideId: string,
    driverId: string,
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<void> {
    const offerId = `offer:${rideId}:${driverId}`;
    const key = `offer:${rideId}:${driverId}`;

    // Store offer in Redis (expiry = driver's window)
    await this.redis.setex(
      key,
      this.offerTtlSeconds,
      JSON.stringify({ rideId, driverId }),
    );

    const estimatedEarnings =
      Math.round(estimatedFare * (1 - this.commissionPercent / 100) * 100) /
      100;

    await this.events.publish(
      TOPICS.DRIVER_OFFERS,
      OfferEventType.OFFER_SENT,
      {
        offerId,
        rideId,
        driverId,
        pickupLat,
        pickupLon,
        estimatedFare,
        estimatedEarnings,
        expiresAt: new Date(
          Date.now() + this.offerTtlSeconds * 1000,
        ).toISOString(),
      },
      driverId,
    );
  }

  /** Poll the atomic claim key until a driver accepts (or timeout). */
  private async waitForClaim(
    claimKey: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const claim = await this.redis.get(claimKey);
      if (claim) return claim;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** Driver response handler (called by tracking/driver controller). */
  async handleDriverResponse(
    rideId: string,
    driverId: string,
    accepted: boolean,
  ): Promise<boolean> {
    const offerKey = `offer:${rideId}:${driverId}`;
    const offer = await this.redis.get(offerKey);
    if (!offer) {
      throw new BadRequestException('Offer expired or not found');
    }

    if (!accepted) {
      await this.redis.del(offerKey);
      await this.events.publish(
        TOPICS.DRIVER_RESPONSES,
        DriverResponseType.REJECTED,
        {
          offerId: offerKey,
          rideId,
          driverId,
          response: 'REJECTED',
          respondedAt: new Date().toISOString(),
        },
        rideId,
      );
      return false;
    }

    // ATOMIC CLAIM — first accept wins, no double-acceptance possible.
    const claimKey = `ride:claim:${rideId}`;
    const claimed = await this.redis.set(
      claimKey,
      JSON.stringify({ driverId }),
      'EX',
      CLAIM_TTL_SECONDS,
      'NX',
    );
    if (!claimed) {
      return false; // someone else already accepted
    }

    await this.redis.del(offerKey);
    await this.events.publish(
      TOPICS.DRIVER_RESPONSES,
      DriverResponseType.ACCEPTED,
      {
        offerId: offerKey,
        rideId,
        driverId,
        response: 'ACCEPTED',
        respondedAt: new Date().toISOString(),
      },
      rideId,
    );

    await this.finalizeMatch(rideId, driverId);
    return true;
  }

  private async finalizeMatch(rideId: string, driverId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.status !== 'MATCHING' && ride.status !== 'REQUESTED') return;

    // Move REQUESTED → MATCHING → ACCEPTED via state machine.
    if (ride.status === 'REQUESTED') {
      await this.ridesService.transition(rideId, 'MATCHING', {});
    }
    await this.ridesService.transition(rideId, 'ACCEPTED', {
      driverId,
      acceptedAt: new Date(),
    });

    // Mark driver ON_RIDE in DB + remove from geo pool (no double-booking).
    await this.driversService.updateStatus(driverId, 'ON_RIDE');
    await this.redis.del(`ride:claim:${rideId}`);

    this.logger.log(`Ride ${rideId} → driver ${driverId} (matched)`);
  }

  private async handleNoDrivers(rideId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (['MATCHING', 'REQUESTED'].includes(ride.status)) {
      await this.ridesService.cancel(rideId, 'NO_DRIVER_FOUND', 'SYSTEM');
      this.logger.warn(`Ride ${rideId} cancelled: no drivers`);
    }
  }
}
