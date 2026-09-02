import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Bucket boundaries are where the alerts sit, so they bracket the product's
 * SLOs (rider read <100ms, write <500ms, 2.5s = bad experience) — a histogram
 * can only answer questions its buckets were cut for.
 */
const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Dispatch waits on a human tapping "accept" — wider spread than a request. */
const DISPATCH_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60];

/** Candidate-count distribution. 0 is the one that matters: supply gaps. */
const CANDIDATE_BUCKETS = [0, 1, 2, 3, 5, 8, 13, 21];

/** Fare distribution in paise — revenue anomaly + pricing-bug detection. */
const FARE_BUCKETS = [
  5_000, 10_000, 20_000, 35_000, 50_000, 100_000, 250_000, 500_000,
];

/** How long a gauge source may take before the scrape gives up on it. */
const GAUGE_SOURCE_DEADLINE_MS = 1_500;

/** Coarse SQL verb. Deliberately NOT the query text — see `observeDbQuery`. */
export type DbOperation =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'other';

export type RelayResult = 'published' | 'retried' | 'parked';

/**
 * The single owner of the Prometheus registry.
 *
 * WHY AN OWNED REGISTRY (not prom-client's default global one): the default
 * registry is module-global state; independent instances collide on duplicate
 * metric registration and nothing can be torn down. Owned = injectable like
 * anything else.
 *
 * WHY SERVICES INJECT IT OPTIONALLY: observability must never be
 * load-bearing. A missing metrics provider degrades to no telemetry, never to
 * a failed ride; call sites use `this.metrics?.x()`.
 *
 * CARDINALITY IS THE FAILURE MODE. Every label is drawn from a bounded set
 * (verb, route *template*, status code, state, enum). A raw URL or user id as
 * a label grows the series count without bound and eventually kills the
 * Prometheus server — a worse outage than having no metric at all. Nothing in
 * this file accepts a free-form identifier as a label.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry = new Registry();
  private readonly prefix: string;

  /** Whether the scrape endpoint should be served. Recording is always on. */
  readonly enabled: boolean;

  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  private readonly httpInFlight: Gauge<string>;

  private readonly rideTransitions: Counter<'from' | 'to'>;
  private readonly rideTransitionConflicts: Counter<'from' | 'to'>;
  private readonly rideFarePaise: Histogram<'rideType'>;

  private readonly dispatches: Counter<'mode' | 'result'>;
  private readonly dispatchDuration: Histogram<'mode' | 'result'>;
  private readonly dispatchCandidates: Histogram<string>;
  private readonly claims: Counter<'result'>;
  private readonly pendingWaiters: Gauge<string>;

  private readonly webhooks: Counter<'source' | 'event' | 'result'>;
  private readonly paymentOutcomes: Counter<'method' | 'status'>;

  private readonly ledgerEntries: Counter<'entryType'>;
  private readonly ledgerDrift: Counter<'walletType'>;

  private readonly relayAttempts: Counter<'result'>;
  private readonly dlqDepth: Gauge<string>;

  private readonly dbDuration: Histogram<'operation'>;
  private readonly dbSlowQueries: Counter<'operation'>;
  private readonly dbPool: Gauge<'state'>;

  private readonly socketConnections: Gauge<'namespace'>;
  private readonly redisBreakers: Gauge<'name' | 'state'>;

  private readonly collectErrors: Counter<'source'>;

  /**
   * Live gauge sources, read at scrape time: the value stays as fresh as the
   * scrape interval with no background job whose failure would silently
   * freeze a gauge at a stale value.
   */
  private dlqDepthSource?: () => Promise<number>;
  private pendingWaitersSource?: () => number;
  private dbPoolSource?: () => { total: number; idle: number; waiting: number };

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('observability.metricsEnabled', true);
    this.prefix = config.get<string>('observability.metricsPrefix', 'obbian_');

    // Event-loop lag, heap, GC pause, fd count, process CPU — what tells you
    // "the pod is saturated" as opposed to "a dependency is slow".
    collectDefaultMetrics({ register: this.registry, prefix: this.prefix });

    this.httpRequests = new Counter({
      name: this.name('http_requests_total'),
      help: 'HTTP requests handled, by route template and status code.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: this.name('http_request_duration_seconds'),
      help: 'HTTP request latency in seconds, by route template.',
      labelNames: ['method', 'route', 'status'],
      buckets: LATENCY_BUCKETS,
      registers: [this.registry],
    });

    this.httpInFlight = new Gauge({
      name: this.name('http_requests_in_flight'),
      help: 'HTTP requests currently being served by this process.',
      registers: [this.registry],
    });

    this.rideTransitions = new Counter({
      name: this.name('ride_transitions_total'),
      help: 'Ride state-machine transitions that were committed.',
      labelNames: ['from', 'to'],
      registers: [this.registry],
    });

    this.rideTransitionConflicts = new Counter({
      name: this.name('ride_transition_conflicts_total'),
      help: 'Ride transitions rejected because the row was no longer in the expected state.',
      labelNames: ['from', 'to'],
      registers: [this.registry],
    });

    this.rideFarePaise = new Histogram({
      name: this.name('ride_fare_paise'),
      help: 'Final ride fare distribution in paise.',
      labelNames: ['rideType'],
      buckets: FARE_BUCKETS,
      registers: [this.registry],
    });

    this.dispatches = new Counter({
      name: this.name('matching_dispatches_total'),
      help: 'Dispatch attempts by mode (hedged/sequential) and outcome.',
      labelNames: ['mode', 'result'],
      registers: [this.registry],
    });

    this.dispatchDuration = new Histogram({
      name: this.name('matching_dispatch_duration_seconds'),
      help: 'Time from dispatch start to a claimed ride or exhaustion.',
      labelNames: ['mode', 'result'],
      buckets: DISPATCH_BUCKETS,
      registers: [this.registry],
    });

    this.dispatchCandidates = new Histogram({
      name: this.name('matching_candidates'),
      help: 'Matchable drivers found per dispatch. The zero bucket is the supply-gap signal.',
      buckets: CANDIDATE_BUCKETS,
      registers: [this.registry],
    });

    this.claims = new Counter({
      name: this.name('matching_claims_total'),
      help: 'Ride claim attempts, won or lost to another driver.',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.pendingWaiters = new Gauge({
      name: this.name('matching_pending_waiters'),
      help: 'Dispatch waiters currently parked on a claim notification.',
      registers: [this.registry],
      collect: () => {
        if (!this.pendingWaitersSource) return;
        try {
          this.pendingWaiters.set(this.pendingWaitersSource());
        } catch {
          this.collectErrors.inc({ source: 'pending_waiters' });
        }
      },
    });

    this.webhooks = new Counter({
      name: this.name('payment_webhooks_total'),
      help: 'Provider webhooks received, by event type and how they were resolved.',
      labelNames: ['source', 'event', 'result'],
      registers: [this.registry],
    });

    this.paymentOutcomes = new Counter({
      name: this.name('payment_outcomes_total'),
      help: 'Terminal payment outcomes by method.',
      labelNames: ['method', 'status'],
      registers: [this.registry],
    });

    this.ledgerEntries = new Counter({
      name: this.name('ledger_entries_total'),
      help: 'Double-entry ledger rows written, by entry type.',
      labelNames: ['entryType'],
      registers: [this.registry],
    });

    this.ledgerDrift = new Counter({
      name: this.name('ledger_drift_detected_total'),
      help: 'Cached wallet balances found to disagree with the ledger replay. Any non-zero value is a data-integrity incident.',
      labelNames: ['walletType'],
      registers: [this.registry],
    });

    this.relayAttempts = new Counter({
      name: this.name('outbox_relay_attempts_total'),
      help: 'Outbox relay attempts by outcome.',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.dlqDepth = new Gauge({
      name: this.name('outbox_dlq_depth'),
      help: 'Outbox events parked in FAILED state. Sustained non-zero means events were lost to consumers.',
      registers: [this.registry],
      collect: async () => {
        if (!this.dlqDepthSource) return;
        try {
          const depth = await this.withDeadline(
            this.dlqDepthSource(),
            'dlq_depth',
          );
          this.dlqDepth.set(depth);
        } catch {
          // Leave the previous value in place. A scrape must never fail (or
          // hang) because a dependency is slow — Prometheus would record the
          // whole target as down and every other metric would vanish with it.
          this.collectErrors.inc({ source: 'dlq_depth' });
        }
      },
    });

    this.dbDuration = new Histogram({
      name: this.name('db_query_duration_seconds'),
      help: 'Postgres query latency by SQL verb.',
      labelNames: ['operation'],
      buckets: LATENCY_BUCKETS,
      registers: [this.registry],
    });

    this.dbSlowQueries = new Counter({
      name: this.name('db_slow_queries_total'),
      help: 'Queries exceeding SLOW_QUERY_MS.',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    this.dbPool = new Gauge({
      name: this.name('db_pool_connections'),
      help: 'Postgres pool connections by state. waiting>0 means requests are queued on the pool, not on the database.',
      labelNames: ['state'],
      registers: [this.registry],
      collect: () => {
        if (!this.dbPoolSource) return;
        try {
          const stats = this.dbPoolSource();
          this.dbPool.set({ state: 'total' }, stats.total);
          this.dbPool.set({ state: 'idle' }, stats.idle);
          this.dbPool.set({ state: 'waiting' }, stats.waiting);
        } catch {
          this.collectErrors.inc({ source: 'db_pool' });
        }
      },
    });

    this.socketConnections = new Gauge({
      name: this.name('realtime_connections'),
      help: 'Currently connected websocket clients on this process.',
      labelNames: ['namespace'],
      registers: [this.registry],
    });

    this.redisBreakers = new Gauge({
      name: this.name('redis_breaker_state'),
      help: 'Redis circuit state, one-hot encoded as closed/open/half_open.',
      labelNames: ['name', 'state'],
      registers: [this.registry],
    });

    this.collectErrors = new Counter({
      name: this.name('metrics_collect_errors_total'),
      help: 'Failures while reading a live gauge source at scrape time.',
      labelNames: ['source'],
      registers: [this.registry],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Drop all recorded values without re-registering metrics. */
  reset(): void {
    this.registry.resetMetrics();
  }

  setDlqDepthSource(source: () => Promise<number>): void {
    this.dlqDepthSource = source;
  }

  setPendingWaitersSource(source: () => number): void {
    this.pendingWaitersSource = source;
  }

  setDbPoolSource(
    source: () => { total: number; idle: number; waiting: number },
  ): void {
    this.dbPoolSource = source;
  }

  /**
   * @param route MUST be a route template (`/api/v1/rides/:id`), never a
   * concrete path — see the cardinality note on the class.
   */
  observeHttpRequest(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  /** Must be paired with `decHttpInFlight`. */
  incHttpInFlight(): void {
    this.httpInFlight.inc();
  }

  decHttpInFlight(): void {
    this.httpInFlight.dec();
  }

  recordRideTransition(from: string, to: string): void {
    this.rideTransitions.inc({ from, to });
  }

  /**
   * A rejected transition is normal (two drivers racing an accept), but a
   * spike means a client retry storm or a genuine double-dispatch bug.
   */
  recordRideTransitionConflict(from: string, to: string): void {
    this.rideTransitionConflicts.inc({ from, to });
  }

  recordRideFare(rideType: string, farePaise: number): void {
    this.rideFarePaise.observe({ rideType }, farePaise);
  }

  recordDispatch(
    mode: 'hedged' | 'sequential',
    result: 'matched' | 'no_driver',
    durationSeconds: number,
  ): void {
    this.dispatches.inc({ mode, result });
    this.dispatchDuration.observe({ mode, result }, durationSeconds);
  }

  recordDispatchCandidates(count: number): void {
    this.dispatchCandidates.observe(count);
  }

  recordClaim(result: 'won' | 'lost'): void {
    this.claims.inc({ result });
  }

  recordWebhook(
    source: string,
    event: string,
    result: 'applied' | 'duplicate' | 'ignored' | 'error',
  ): void {
    this.webhooks.inc({ source, event, result });
  }

  recordPaymentOutcome(method: string, status: string): void {
    this.paymentOutcomes.inc({ method, status });
  }

  recordLedgerEntry(entryType: string, count = 1): void {
    this.ledgerEntries.inc({ entryType }, count);
  }

  recordLedgerDrift(walletType: string): void {
    this.ledgerDrift.inc({ walletType });
  }

  recordRelayResult(result: RelayResult, count = 1): void {
    if (count <= 0) return;
    this.relayAttempts.inc({ result }, count);
  }

  /**
   * @param operation coarse SQL verb only. The query text is deliberately not
   * a label: it is unbounded, and bind values would leak PII into the metric
   * store, which is typically far less protected than the database.
   */
  observeDbQuery(operation: DbOperation, durationSeconds: number): void {
    this.dbDuration.observe({ operation }, durationSeconds);
  }

  recordSlowQuery(operation: DbOperation): void {
    this.dbSlowQueries.inc({ operation });
  }

  incSocketConnections(namespace: string): void {
    this.socketConnections.inc({ namespace });
  }

  decSocketConnections(namespace: string): void {
    this.socketConnections.dec({ namespace });
  }

  setRedisBreakerState(
    name: string,
    state: 'closed' | 'open' | 'half_open',
  ): void {
    for (const value of ['closed', 'open', 'half_open'] as const) {
      this.redisBreakers.set({ name, state: value }, value === state ? 1 : 0);
    }
  }

  private name(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  /**
   * Bound a gauge source so one slow dependency cannot stall the whole
   * scrape. Timer is always cleared: a dangling timer keeps the event loop
   * alive and blocks graceful shutdown.
   */
  private async withDeadline<T>(
    promise: Promise<T>,
    source: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `gauge source ${source} exceeded ${GAUGE_SOURCE_DEADLINE_MS}ms`,
                ),
              ),
            GAUGE_SOURCE_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
