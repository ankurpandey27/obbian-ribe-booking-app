import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  InjectRedis,
  InjectRedisPublisher,
  InjectRedisSubscriber,
} from '../../common/redis/redis.decorator';
import { MetricsService } from '../../common/observability/metrics.service';
import { RedisCircuitBreaker } from '../../common/redis/redis-circuit-breaker.service';

/**
 * One channel for every ride claim, one subscription for the process lifetime,
 * with the rideId in the payload. Deliberately NOT one channel per ride: at
 * 1M rides/day that is constant SUBSCRIBE/UNSUBSCRIBE churn, and Redis tracks
 * channel subscriptions per connection, so the bookkeeping cost scales with
 * concurrency for no benefit. Fan-out to the right waiter happens in-process.
 */
const CLAIM_CHANNEL = 'ride:claims';

/** Claim keys are the durable source of truth; the message is only a wake-up. */
const claimKey = (rideId: string) => `ride:claim:${rideId}`;

export interface RideClaim {
  rideId: string;
  driverId: string;
}

interface ClaimMessage {
  rideId: string;
  driverId: string;
  /** ACCEPTED wakes every waiter; DECLINED only wakes the one on that driver. */
  outcome: 'ACCEPTED' | 'DECLINED';
}

interface Waiter {
  resolve: (claim: RideClaim | null) => void;
  timer: NodeJS.Timeout;
  /** Sequential dispatch: this waiter holds the window for one specific driver. */
  awaitingDriverId?: string;
}

/**
 * Event-driven wait for "a driver accepted this ride" — replaces a 500ms
 * busy-poll that cost ~2 wasted GETs/s per in-flight match and added up to
 * 500ms of rider-visible latency.
 *
 * CORRECTNESS UNDER MESSAGE LOSS: pub/sub is fire-and-forget, so a message can
 * be missed. The claim key (SET NX), not the message, decides every outcome —
 * each wait ends with one authoritative GET before reporting "no driver".
 * Pub/sub is an optimisation over polling, never the source of truth.
 */
@Injectable()
export class RideClaimCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RideClaimCoordinator.name);

  /** rideId → waiters. A Set because several workers may await one ride. */
  private readonly waiters = new Map<string, Set<Waiter>>();
  private subscribed = false;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRedisPublisher() private readonly publisher: Redis,
    @InjectRedisSubscriber() private readonly subscriber: Redis,
    private readonly breaker: RedisCircuitBreaker,
    /** Optional so telemetry can never be the reason a claim fails. */
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Parked waiters are read at scrape time: the value is only meaningful as
    // a level, and a growing level is the signal that dispatch waits are
    // leaking — a bug that silently consumes worker slots until matching stops.
    this.metrics?.setPendingWaitersSource(() => this.pendingWaiterCount);

    // Wire the handler before subscribing so no message can arrive unhandled.
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CLAIM_CHANNEL) return;
      this.dispatch(raw);
    });

    try {
      await this.subscriber.subscribe(CLAIM_CHANNEL);
      this.subscribed = true;
      this.logger.log(`subscribed to ${CLAIM_CHANNEL}`);
    } catch (err) {
      // Degrade, don't refuse to boot: every wait still resolves via its
      // final GET — just at timeout granularity instead of instantly.
      this.logger.error(
        `subscribe failed, claims will resolve on timeout only: ${
          (err as Error).message
        }`,
      );
    }

    // ioredis resubscribes automatically; log so a flapping connection is
    // visible rather than silently costing latency.
    this.subscriber.on('reconnecting', () =>
      this.logger.warn('claim subscriber reconnecting'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const [rideId, set] of this.waiters) {
      for (const waiter of set) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      this.waiters.delete(rideId);
    }
    if (this.subscribed) {
      await this.subscriber.unsubscribe(CLAIM_CHANNEL).catch(() => undefined);
    }
  }

  /**
   * Record the winning claim atomically and wake any waiter.
   *
   * SET NX is the actual decision: the first driver to land the key wins, and
   * publishing only happens for the winner, so a losing accept can never wake
   * a waiter with the wrong driver. Publish failure is survivable — the
   * waiter's final GET still finds the key — so it must not fail the accept.
   *
   * Returns true if this caller won the claim.
   */
  async claim(
    rideId: string,
    driverId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.breaker.execute('claim_write', 'closed', () =>
      this.redis.set(
        claimKey(rideId),
        JSON.stringify({ driverId }),
        'EX',
        ttlSeconds,
        'NX',
      ),
    );
    const won = result === 'OK';
    this.metrics?.recordClaim(won ? 'won' : 'lost');
    if (!won) return false;

    await this.publish({ rideId, driverId, outcome: 'ACCEPTED' });
    return true;
  }

  /**
   * Lets SEQUENTIAL dispatch move on the moment a driver says no instead of
   * sleeping out their window. Carries no authority — a lost message only
   * costs the caller its full timeout.
   */
  async notifyDeclined(rideId: string, driverId: string): Promise<void> {
    await this.publish({ rideId, driverId, outcome: 'DECLINED' });
  }

  private async publish(message: ClaimMessage): Promise<void> {
    await this.breaker
      .execute('claim_pubsub', 'open', () =>
        this.publisher.publish(CLAIM_CHANNEL, JSON.stringify(message)),
      )
      .catch((err: unknown) =>
        this.logger.warn(
          `publish ${message.outcome} failed: ${(err as Error).message}`,
        ),
      );
  }

  async getClaim(rideId: string): Promise<RideClaim | null> {
    const raw = await this.breaker.execute('claim_lookup', 'open', () =>
      this.redis.get(claimKey(rideId)),
    );
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { driverId: string };
      return { rideId, driverId: parsed.driverId };
    } catch {
      this.logger.error(`malformed claim payload for ride=${rideId}: ${raw}`);
      return null;
    }
  }

  async releaseClaim(rideId: string): Promise<void> {
    await this.breaker
      .execute('claim_write', 'open', () => this.redis.del(claimKey(rideId)))
      .catch(() => undefined);
  }

  /**
   * Wait for a driver to claim this ride, or resolve null at the deadline.
   *
   * REGISTER FIRST, then check the key — ordering is load-bearing. Checking
   * the key first leaves a window in which a claim can be published before
   * this waiter exists: the message reaches nobody and the caller stalls for
   * its whole timeout (a 35-second stall in hedged dispatch on a ride a
   * driver already accepted). Registering first means no message can be
   * missed; the immediately-following GET covers the claim that landed
   * before we registered, and the final GET covers a message lost in transit.
   */
  async waitForClaim(
    rideId: string,
    timeoutMs: number,
    awaitingDriverId?: string,
  ): Promise<RideClaim | null> {
    let settled = false;
    let waiter: Waiter | undefined;

    const pending = new Promise<RideClaim | null>((resolve) => {
      waiter = {
        resolve: (claim) => {
          settled = true;
          resolve(claim);
        },
        awaitingDriverId,
        timer: setTimeout(() => {
          if (waiter) this.removeWaiter(rideId, waiter);
          settled = true;
          resolve(null);
        }, timeoutMs),
      };
      this.addWaiter(rideId, waiter);
    });

    const existing = await this.getClaim(rideId);
    if (existing && !settled && waiter) {
      clearTimeout(waiter.timer);
      this.removeWaiter(rideId, waiter);
      return existing;
    }

    const claim = await pending;
    if (claim) return claim;

    return this.getClaim(rideId);
  }

  /**
   * Waiters are removed before resolving so a duplicate message (Redis can
   * deliver more than once across a reconnect) cannot resolve a settled promise.
   */
  private dispatch(raw: string): void {
    let payload: ClaimMessage;
    try {
      payload = JSON.parse(raw) as ClaimMessage;
    } catch {
      this.logger.error(`malformed claim message: ${raw}`);
      return;
    }
    if (!payload?.rideId || !payload?.driverId) return;

    const set = this.waiters.get(payload.rideId);
    if (!set || set.size === 0) return;

    if (payload.outcome === 'DECLINED') {
      // Only the waiter holding that driver's window cares — one driver
      // saying no does not mean the ride went unclaimed.
      for (const waiter of [...set]) {
        if (waiter.awaitingDriverId !== payload.driverId) continue;
        this.removeWaiter(payload.rideId, waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      return;
    }

    // ACCEPTED — the ride is decided, so every waiter is done.
    this.waiters.delete(payload.rideId);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        rideId: payload.rideId,
        driverId: payload.driverId,
      });
    }
  }

  private addWaiter(rideId: string, waiter: Waiter): void {
    const set = this.waiters.get(rideId) ?? new Set<Waiter>();
    set.add(waiter);
    this.waiters.set(rideId, set);
  }

  private removeWaiter(rideId: string, waiter: Waiter): void {
    const set = this.waiters.get(rideId);
    if (!set) return;
    set.delete(waiter);
    // Empty Sets left behind are a slow memory leak keyed by every ride the
    // process has ever matched.
    if (set.size === 0) this.waiters.delete(rideId);
  }

  get pendingWaiterCount(): number {
    let total = 0;
    for (const set of this.waiters.values()) total += set.size;
    return total;
  }
}
