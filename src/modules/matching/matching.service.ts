import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { DriversService } from '../drivers/drivers.service';
import { RidesService } from '../rides/rides.service';
import { EventBus } from '../../common/events/event-bus.service';
import { TOPICS } from '../../shared/events/topics';
import {
  DriverResponseType,
  OfferEventType,
} from '../../shared/events/contracts';

import { Driver } from '../drivers/entities/driver.entity';
import { RideClaimCoordinator } from './ride-claim.coordinator';
import { MetricsService } from '../../common/observability/metrics.service';

const CLAIM_TTL_SECONDS = 30;

export interface OfferResult {
  rideId: string;
  driverId: string;
  offerId: string;
}

/**
 * MatchingService — dispatch engine.
 *
 * 1. Find nearby matchable drivers (Redis geo → heartbeat → Postgres filter,
 *    cheapest stage first).
 * 2. Rank by rating and proximity.
 * 3. Offer to the top N — HEDGED (default: all at once, first accept wins) or
 *    SEQUENTIAL (one at a time).
 * 4. A driver accept writes an ATOMIC claim (SET NX) — double-acceptance is
 *    impossible by construction.
 * 5. Ride transitions to ACCEPTED; remaining offers lapse via their TTL.
 *
 * Runs as a BullMQ job so a crash mid-match is retryable; the atomic claim makes
 * retries safe.
 *
 * WAITING IS EVENT-DRIVEN (RideClaimCoordinator), not polled. The previous
 * implementation woke every 500ms to GET the claim key, which cost ~2 wasted
 * Redis reads per second per in-flight match and added up to half a second of
 * latency to every successful dispatch. Sequential mode additionally slept its
 * full per-driver window even when the driver had already rejected.
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
    private readonly claims: RideClaimCoordinator,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
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
   * Entry point, called after ride creation. Attempts to find a driver.
   * Idempotent: only a still-REQUESTED ride is dispatched, so a job retry after
   * a successful match is a no-op.
   */
  async matchRide(rideId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.status !== 'REQUESTED') {
      return;
    }

    await this.dispatchOffers(
      rideId,
      ride.pickupLat,
      ride.pickupLon,
      ride.rideType,
      Number(ride.estimatedFare),
    );
  }

  /**
   * Times the dispatch and records its outcome, whatever path it took.
   *
   * The measurement is deliberately wrapped around the whole attempt rather than
   * sprinkled at each exit: dispatch has five terminal paths, and an instrumented
   * `return` is exactly the kind of thing a later refactor forgets — leaving a
   * silently under-counted metric, which is worse than none because it looks
   * healthy.
   */
  private async dispatchOffers(
    rideId: string,
    pickupLat: number,
    pickupLon: number,
    rideType: string,
    estimatedFare: number,
  ): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const mode = this.hedged ? 'hedged' : 'sequential';
    let result: 'matched' | 'no_driver' = 'no_driver';
    try {
      result = await this.runDispatch(
        rideId,
        pickupLat,
        pickupLon,
        rideType,
        estimatedFare,
      );
    } finally {
      this.metrics?.recordDispatch(
        mode,
        result,
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    }
  }

  private async runDispatch(
    rideId: string,
    pickupLat: number,
    pickupLon: number,
    rideType: string,
    estimatedFare: number,
  ): Promise<'matched' | 'no_driver'> {
    const candidates = await this.driversService.findMatchableDrivers(
      pickupLon,
      pickupLat,
      this.radiusKm,
      rideType,
      10,
    );

    // The zero bucket of this histogram IS the supply-gap metric: "how often did
    // a rider ask and we had nobody" is a demand-planning input, not just an
    // error count.
    this.metrics?.recordDispatchCandidates(candidates.length);

    if (candidates.length === 0) {
      await this.handleNoDrivers(rideId);
      return 'no_driver';
    }

    // Rank: rating weighted, with proximity implicit — findMatchableDrivers
    // returns closest-first from the geo index.
    const scored = candidates
      .map((d, idx) => ({
        driver: d,
        score:
          Number(d.rating) * 40 + (idx === 0 ? 60 : Math.max(0, 60 - idx * 10)),
      }))
      .sort((a, b) => b.score - a.score);

    const topN = scored.slice(0, this.maxCandidates);

    if (this.hedged) {
      // All offers out at once, then one wait for whoever accepts first.
      await this.dispatchHedged(
        rideId,
        topN,
        pickupLat,
        pickupLon,
        estimatedFare,
      );
      const claim = await this.claims.waitForClaim(
        rideId,
        this.offerTtlSeconds * 1000 + 5000,
      );
      if (!claim) {
        await this.handleNoDrivers(rideId);
        return 'no_driver';
      }
      await this.finalizeMatch(rideId, claim.driverId);
      return 'matched';
    }

    // Sequential: each candidate gets a window, and we move on the instant they
    // reject rather than sleeping out the clock.
    const claim = await this.dispatchSequential(
      rideId,
      topN,
      pickupLat,
      pickupLon,
      estimatedFare,
    );
    if (!claim) {
      await this.handleNoDrivers(rideId);
      return 'no_driver';
    }
    await this.finalizeMatch(rideId, claim.driverId);
    return 'matched';
  }

  private async dispatchHedged(
    rideId: string,
    candidates: { driver: Driver; score: number }[],
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<void> {
    // Offers are independent — fan out rather than awaiting each in turn, so
    // the last candidate is not disadvantaged by the round-trips before them.
    await Promise.all(
      candidates.map(({ driver }) =>
        this.sendOffer(
          rideId,
          driver.userId,
          pickupLat,
          pickupLon,
          estimatedFare,
        ).catch((err) =>
          this.logger.error(
            `offer to ${driver.userId} failed for ride=${rideId}: ${
              (err as Error).message
            }`,
          ),
        ),
      ),
    );
  }

  /**
   * Offer to one candidate at a time, waiting on the claim event rather than a
   * blind sleep. A rejection resolves the wait immediately via the same
   * coordinator, so the next driver is offered the ride in milliseconds instead
   * of after the full window.
   */
  private async dispatchSequential(
    rideId: string,
    candidates: { driver: Driver; score: number }[],
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<{ driverId: string } | null> {
    for (const { driver } of candidates) {
      await this.sendOffer(
        rideId,
        driver.userId,
        pickupLat,
        pickupLon,
        estimatedFare,
      );

      // Passing the driver id makes THIS driver's decline end the wait early,
      // rather than sleeping out the remainder of their window.
      const claim = await this.claims.waitForClaim(
        rideId,
        this.sequentialWindowMs,
        driver.userId,
      );
      if (claim) return claim;

      // Window elapsed or driver declined — withdraw and try the next.
      await this.redis
        .del(this.offerKey(rideId, driver.userId))
        .catch(() => undefined);
    }
    return null;
  }

  private async sendOffer(
    rideId: string,
    driverId: string,
    pickupLat: number,
    pickupLon: number,
    estimatedFare: number,
  ): Promise<void> {
    const key = this.offerKey(rideId, driverId);

    // The offer key IS the authorisation to accept: an accept with no live key
    // is rejected, so the TTL is what expires an unanswered offer.
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
        offerId: key,
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

  /**
   * Driver accept/decline, called from the driver-facing controller.
   *
   * The atomic claim lives in RideClaimCoordinator: first accept wins, losers
   * get `false` rather than an error, because losing a race is a normal outcome
   * and not a client mistake.
   */
  async handleDriverResponse(
    rideId: string,
    driverId: string,
    accepted: boolean,
  ): Promise<boolean> {
    const offerKey = this.offerKey(rideId, driverId);
    const offer = await this.redis.get(offerKey);
    if (!offer) {
      throw new BadRequestException('Offer expired or not found');
    }

    if (!accepted) {
      await this.redis.del(offerKey);
      // Wake a sequential dispatcher immediately so the next candidate is
      // offered the ride now rather than when this driver's window lapses.
      await this.claims.notifyDeclined(rideId, driverId);
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

    const won = await this.claims.claim(rideId, driverId, CLAIM_TTL_SECONDS);
    if (!won) {
      // Another driver already has it.
      await this.redis.del(offerKey).catch(() => undefined);
      return false;
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

    // Finalise here as well as in the dispatch loop: the accept path must not
    // depend on a worker still being alive to observe the claim. finalizeMatch
    // is idempotent on ride status, so whichever runs second is a no-op.
    await this.finalizeMatch(rideId, driverId);
    return true;
  }

  /**
   * Move the ride to ACCEPTED and take the driver out of the dispatch pool.
   *
   * Guarded on the observed status so the two callers (dispatch loop and accept
   * handler) cannot both apply it — the state machine's conditional update
   * rejects the loser.
   */
  private async finalizeMatch(rideId: string, driverId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.status !== 'MATCHING' && ride.status !== 'REQUESTED') return;

    try {
      if (ride.status === 'REQUESTED') {
        await this.ridesService.transition(rideId, 'MATCHING', {});
      }
      await this.ridesService.transition(rideId, 'ACCEPTED', {
        driverId,
        acceptedAt: new Date(),
      });
    } catch (err) {
      // A ConflictException here means the other caller won the transition —
      // expected, not an error worth surfacing.
      this.logger.debug(
        `finalizeMatch lost the race for ride=${rideId}: ${(err as Error).message}`,
      );
      return;
    }

    await this.driversService.updateStatus(driverId, 'ON_RIDE');
    await this.claims.releaseClaim(rideId);

    this.logger.log(`Ride ${rideId} → driver ${driverId} (matched)`);
  }

  private async handleNoDrivers(rideId: string): Promise<void> {
    const ride = await this.ridesService.getRide(rideId);
    if (['MATCHING', 'REQUESTED'].includes(ride.status)) {
      await this.ridesService.cancel(rideId, 'NO_DRIVER_FOUND', 'SYSTEM');
      this.logger.warn(`Ride ${rideId} cancelled: no drivers`);
    }
  }

  private offerKey(rideId: string, driverId: string): string {
    return `offer:${rideId}:${driverId}`;
  }
}
