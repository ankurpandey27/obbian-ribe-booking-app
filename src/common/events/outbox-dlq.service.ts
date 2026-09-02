import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../database/drizzle.module';
import { outboxEvents } from '../database/schema';
import { MetricsService } from '../observability/metrics.service';

export interface DlqEntry {
  id: string;
  topic: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  retriedAt: Date | null;
}

export interface DlqSummary {
  failedCount: number;
  oldestFailedAt: Date | null;
  /** Failure counts grouped by event type — shows WHAT is broken, not just how much. */
  byType: Array<{ type: string; count: number }>;
}

export interface DlqRetryResult {
  requeued: number;
  ids: string[];
}

/**
 * OutboxDlqService — visibility and recovery for events that exhausted retries.
 *
 * WHY: `OutboxService.relayOnce()` retries a row up to `events.maxAttempts` (8)
 * and then parks it at `status = 'FAILED'`. Nothing ever looked at those rows
 * again. Because the outbox is where DURABLE facts live — ride completed,
 * payment succeeded, driver settled — a FAILED row is a fact that never reached
 * its consumers, with no alert and no way to replay it. Silent data loss with a
 * paper trail nobody reads.
 *
 * This service is the surface: summarise what is stuck, inspect it, and requeue
 * it once the underlying cause is fixed.
 *
 * DESIGN NOTES
 *  - Retry RESETS `attempts` to 0 so the row gets a fresh budget from the relay.
 *    Leaving the count at 8 would have it re-fail on the first hiccup.
 *  - `retriedAt` / `retriedBy` record who replayed what. Requeuing a payment
 *    event is a privileged act and needs provenance.
 *  - Batches are capped by `events.dlqRetryBatchLimit` so one accidental click
 *    cannot stampede the relay with thousands of publishes.
 *  - Retry does NOT re-derive the payload. The stored payload is the historical
 *    fact; regenerating it from current state would replay a different event
 *    than the one that originally failed.
 */
@Injectable()
export class OutboxDlqService implements OnModuleInit {
  private readonly logger = new Logger(OutboxDlqService.name);
  private readonly retryBatchLimit: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.retryBatchLimit = config.get<number>('events.dlqRetryBatchLimit', 50);
  }

  onModuleInit(): void {
    this.metrics?.setDlqDepthSource(async () => {
      const [row] = await this.db
        .select({ depth: count() })
        .from(outboxEvents)
        .where(eq(outboxEvents.status, 'FAILED'));
      return Number(row?.depth ?? 0);
    });
  }

  /**
   * Health snapshot. Cheap enough to poll from a dashboard or alert rule —
   * backed by the partial index `IDX_outbox_dlq`, so it only touches FAILED rows.
   */
  async summary(): Promise<DlqSummary> {
    const [totals] = await this.db
      .select({
        failedCount: count(),
        oldest: sql<Date | null>`MIN(${outboxEvents.createdAt})`,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'FAILED'));

    const byType = await this.db
      .select({
        type: outboxEvents.type,
        count: count(),
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'FAILED'))
      .groupBy(outboxEvents.type)
      .orderBy(desc(count()));

    return {
      failedCount: Number(totals?.failedCount ?? 0),
      oldestFailedAt: totals?.oldest ? new Date(totals.oldest) : null,
      byType: byType.map((r) => ({ type: r.type, count: Number(r.count) })),
    };
  }

  /** Paginated DLQ listing, newest first. Payloads are deliberately excluded. */
  async list(limit = 50, offset = 0): Promise<DlqEntry[]> {
    const rows = await this.db
      .select({
        id: outboxEvents.id,
        topic: outboxEvents.topic,
        type: outboxEvents.type,
        aggregateType: outboxEvents.aggregateType,
        aggregateId: outboxEvents.aggregateId,
        attempts: outboxEvents.attempts,
        lastError: outboxEvents.lastError,
        createdAt: outboxEvents.createdAt,
        retriedAt: outboxEvents.retriedAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, 'FAILED'))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(Math.min(limit, 200))
      .offset(offset);
    return rows.map((r) => ({ ...r, lastError: r.lastError ?? null }));
  }

  /** One row including its payload, for diagnosing a specific failure. */
  async getById(
    id: string,
  ): Promise<(DlqEntry & { payload: Record<string, unknown> }) | null> {
    const [row] = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, id))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      topic: row.topic,
      type: row.type,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      attempts: row.attempts,
      lastError: row.lastError ?? null,
      createdAt: row.createdAt,
      retriedAt: row.retriedAt ?? null,
      payload: row.payload ?? {},
    };
  }

  /**
   * Requeue specific rows.
   *
   * Conditional on `status = 'FAILED'` so a row the relay has already picked up
   * cannot be yanked back to PENDING mid-flight and published twice.
   */
  async retry(ids: string[], actorUserId?: string): Promise<DlqRetryResult> {
    if (ids.length === 0) return { requeued: 0, ids: [] };

    const capped = ids.slice(0, this.retryBatchLimit);
    const requeued = await this.db
      .update(outboxEvents)
      .set({
        status: 'PENDING',
        // Fresh retry budget — otherwise the relay burns through the remaining
        // (zero) attempts and parks it again immediately.
        attempts: 0,
        lastError: null,
        retriedAt: new Date(),
        retriedBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(outboxEvents.id, capped),
          eq(outboxEvents.status, 'FAILED'),
        ),
      )
      .returning({ id: outboxEvents.id });

    if (requeued.length > 0) {
      this.logger.warn(
        `requeued ${requeued.length} DLQ event(s)` +
          (actorUserId ? ` by ${actorUserId}` : ''),
      );
    }
    return { requeued: requeued.length, ids: requeued.map((r) => r.id) };
  }

  /**
   * Requeue every FAILED row of one event type, oldest first.
   *
   * The realistic recovery shape: one downstream consumer or topic was broken
   * for a window, so a whole class of events failed together. Bounded by the
   * same batch limit, so recovering a large backlog is several deliberate calls
   * rather than one unbounded flood.
   */
  async retryByType(
    type: string,
    actorUserId?: string,
  ): Promise<DlqRetryResult> {
    const candidates = await this.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.status, 'FAILED'), eq(outboxEvents.type, type)),
      )
      .orderBy(outboxEvents.createdAt)
      .limit(this.retryBatchLimit);

    return this.retry(
      candidates.map((c) => c.id),
      actorUserId,
    );
  }

  /**
   * Purge PUBLISHED rows older than the cutoff.
   *
   * The outbox doubles as a replay/audit log, so published rows are kept for a
   * window and then dropped. FAILED rows are NEVER purged here — they represent
   * unresolved data loss and must be dealt with explicitly, not aged out.
   */
  async purgePublishedOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'PUBLISHED'),
          lt(outboxEvents.createdAt, cutoff),
        ),
      )
      .returning({ id: outboxEvents.id });
    if (deleted.length > 0) {
      this.logger.log(`purged ${deleted.length} published outbox row(s)`);
    }
    return deleted.length;
  }
}
