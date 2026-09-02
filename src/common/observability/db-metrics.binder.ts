import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/drizzle.module';
import { MetricsService, DbOperation } from './metrics.service';

/** Marker so a client is never wrapped twice (pg may re-emit `connect`). */
const INSTRUMENTED = Symbol('obbian.instrumented');

/** Truncate SQL in slow-query logs; the shape is diagnostic, the tail is not. */
const MAX_SQL_LOG_CHARS = 300;

interface Queryable {
  query: (...args: unknown[]) => unknown;
  [INSTRUMENTED]?: boolean;
}

/**
 * Postgres latency, slow queries and pool occupancy.
 *
 * Lives here and not in DrizzleModule so the data layer never knows about
 * observability — removing metrics is a one-line change.
 *
 * WHY IT WRAPS `client.query` AND NOT `pool.query`: `pool.query()` internally
 * acquires a client and delegates to `client.query()`, so wrapping both would
 * double-count every non-transactional statement. Wrapping the client alone
 * covers BOTH paths — including transactions, which is where the expensive
 * statements actually are (ride completion writes the state change, the outbox
 * row, the fare breakdown, the invoice and the ledger entries in one).
 *
 * Callback- and cursor-form queries pass through unmeasured: detecting their
 * completion means intercepting a callback, and getting that subtly wrong
 * would corrupt query results. Nothing in this codebase uses those forms —
 * Drizzle is promise-based throughout.
 */
@Injectable()
export class DbMetricsBinder implements OnModuleInit {
  private readonly logger = new Logger(DbMetricsBinder.name);
  private readonly slowQueryMs: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.slowQueryMs = config.get<number>('observability.slowQueryMs', 500);
  }

  onModuleInit(): void {
    // `waitingCount > 0` means requests are queued on the pool, not the
    // database — without it, pool exhaustion is indistinguishable from a
    // slow database.
    this.metrics.setDbPoolSource(() => ({
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    }));

    // Clients connect lazily, so this covers the whole pool lifetime; the
    // pool is empty until the first query, which cannot precede module init.
    this.pool.on('connect', (client: unknown) => {
      if (isQueryable(client)) this.instrument(client);
    });
  }

  private instrument(client: Queryable): void {
    if (client[INSTRUMENTED]) return;
    client[INSTRUMENTED] = true;

    const original = client.query.bind(client);
    client.query = (...args: unknown[]): unknown => {
      const startedAt = process.hrtime.bigint();
      let result: unknown;
      try {
        result = original(...args);
      } catch (err) {
        this.record(args, startedAt);
        throw err;
      }

      if (!isPromiseLike(result)) {
        // Callback or Submittable form — pass through untouched.
        return result;
      }

      return result.then(
        (value) => {
          this.record(args, startedAt);
          return value;
        },
        (err) => {
          // Failed queries are timed too: a statement_timeout kill is slow by
          // definition, and excluding it would hide the worst latency.
          this.record(args, startedAt);
          throw err;
        },
      );
    };
  }

  private record(args: unknown[], startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const sql = extractSql(args);
    const operation = classify(sql);

    this.metrics.observeDbQuery(operation, durationMs / 1000);

    if (durationMs >= this.slowQueryMs) {
      this.metrics.recordSlowQuery(operation);
      /*
       * The parameterised SQL TEXT is logged; bind values never are. Values
       * are phone numbers, ride ids and payment references — writing them
       * into the log store would spread personal data into a system with
       * weaker access controls than the database, and the text alone is what
       * identifies the query plan to fix.
       */
      this.logger.warn(
        `slow query ${durationMs.toFixed(1)}ms op=${operation} sql=${truncate(sql)}`,
      );
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

function isQueryable(value: unknown): value is Queryable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { query?: unknown }).query === 'function'
  );
}

function extractSql(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (
    typeof first === 'object' &&
    first !== null &&
    typeof (first as { text?: unknown }).text === 'string'
  ) {
    return (first as { text: string }).text;
  }
  return '';
}

/** Coarse verb only — see the cardinality note on MetricsService. */
function classify(sql: string): DbOperation {
  const verb = sql.trimStart().slice(0, 12).toLowerCase();
  if (verb.startsWith('select')) return 'select';
  if (verb.startsWith('insert')) return 'insert';
  if (verb.startsWith('update')) return 'update';
  if (verb.startsWith('delete')) return 'delete';
  if (verb.startsWith('begin')) return 'begin';
  if (verb.startsWith('commit')) return 'commit';
  if (verb.startsWith('rollback')) return 'rollback';
  return 'other';
}

function truncate(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SQL_LOG_CHARS
    ? `${flat.slice(0, MAX_SQL_LOG_CHARS)}…`
    : flat;
}
