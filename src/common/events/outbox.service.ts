import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { Producer } from 'kafkajs';
import { DRIZZLE_DB, DrizzleDB } from '../database/drizzle.module';
import { outboxEvents } from '../database/schema';
import { DomainEvent, TopicName } from '../../shared/events/topics';
import { KAFKA_PRODUCER } from './kafka.module';

export interface OutboxWrite {
  topic: TopicName;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
/** Accepts either the root handle or an open transaction. */
type Exec = DrizzleDB | Tx;

const BATCH_SIZE = 100;
/** Rows stuck in PROCESSING longer than this were lost to a crash → re-claim. */
const PROCESSING_STALE_MS = 120_000;

/**
 * OutboxService — dual role:
 *  1. write(): called INSIDE a business transaction (Drizzle tx) so the
 *     event is committed atomically with the state change it describes.
 *  2. relayOnce(): claims pending rows (FOR UPDATE SKIP LOCKED — safe with
 *     multiple app instances) and publishes at-least-once.
 *
 * Brokerless mode (EVENTS_BROKER_ENABLED=false): rows drain as PUBLISHED
 * without sending — the durable log still exists for replay/audit.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly brokerEnabled: boolean;
  private readonly maxAttempts: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    config: ConfigService,
  ) {
    this.brokerEnabled =
      config.get<string>('events.brokerEnabled', 'false') === 'true';
    this.maxAttempts = config.get<number>('events.maxAttempts', 8);
  }

  /** Persist an event inside the caller's open transaction. */
  async write(exec: Exec, evt: OutboxWrite): Promise<void> {
    await exec.insert(outboxEvents).values({
      topic: evt.topic,
      type: evt.type,
      aggregateType: evt.aggregateType,
      aggregateId: evt.aggregateId,
      payload: evt.payload,
      status: 'PENDING',
    });
  }

  /**
   * Claim + publish one batch. Returns the number of dispatched rows.
   * Safe to run concurrently across instances (SKIP LOCKED) and safe to
   * re-run after crashes (stale PROCESSING rows are re-claimed).
   */
  async relayOnce(): Promise<number> {
    const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MS);
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(
          or(
            eq(outboxEvents.status, 'PENDING'),
            and(
              eq(outboxEvents.status, 'PROCESSING'),
              lt(outboxEvents.updatedAt, staleCutoff),
            ),
          ),
        )
        .orderBy(asc(outboxEvents.createdAt))
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });

      if (rows.length === 0) return [];
      await tx
        .update(outboxEvents)
        .set({ status: 'PROCESSING' })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );
      return rows;
    });

    if (claimed.length === 0) return 0;
    for (const row of claimed) {
      await this.dispatch(row);
    }
    return claimed.length;
  }

  private async dispatch(row: typeof outboxEvents.$inferSelect): Promise<void> {
    try {
      if (this.brokerEnabled) {
        const event: DomainEvent<unknown> = {
          id: row.id,
          topic: row.topic as TopicName,
          type: row.type,
          timestamp: row.createdAt.toISOString(),
          payload: row.payload,
        };
        await this.producer.send({
          topic: row.topic,
          messages: [{ key: row.aggregateId, value: JSON.stringify(event) }],
        });
      }
      await this.db
        .update(outboxEvents)
        .set({ status: 'PUBLISHED', publishedAt: new Date(), lastError: null })
        .where(eq(outboxEvents.id, row.id));
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= this.maxAttempts;
      await this.db
        .update(outboxEvents)
        .set({
          attempts,
          lastError: (err as Error).message.slice(0, 500),
          status: dead ? 'FAILED' : 'PENDING',
        })
        .where(eq(outboxEvents.id, row.id))
        .catch(() => undefined);
      this.logger.error(
        `outbox dispatch failed (${attempts}/${this.maxAttempts}) ` +
          `event=${row.type} agg=${row.aggregateId}: ${(err as Error).message}`,
      );
    }
  }
}
