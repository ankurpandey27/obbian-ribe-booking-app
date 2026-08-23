import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Producer } from 'kafkajs';
import { randomUUID } from 'crypto';
import { DomainEvent, TopicName } from '../../shared/events/topics';
import { KAFKA_PRODUCER } from './kafka.module';
import { OutboxEvent, OUTBOX_STATUS } from './outbox.entity';

export interface OutboxWrite {
  topic: TopicName;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const BATCH_SIZE = 100;
/** Rows stuck in PROCESSING longer than this were lost to a crash → re-claim. */
const PROCESSING_STALE_MS = 120_000;

/**
 * OutboxService — dual role:
 *  1. write(): called INSIDE a business transaction so the event is
 *     committed atomically with the state change it describes.
 *  2. relayOnce(): claims pending rows (FOR UPDATE SKIP LOCKED — safe with
 *     multiple app instances) and publishes to the broker at-least-once.
 *
 * Brokerless mode (EVENTS_BROKER_ENABLED=false, e.g. free-tier deploys):
 * rows are drained as PUBLISHED without sending — the durable log still
 * exists in Postgres for replay/audit.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly brokerEnabled: boolean;
  private readonly maxAttempts: number;

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    config: ConfigService,
  ) {
    this.brokerEnabled =
      (config.get<string>('events.brokerEnabled', 'false')) === 'true';
    this.maxAttempts = config.get<number>('events.maxAttempts', 8);
  }

  /** Persist an event inside the caller's open transaction. */
  async write(em: EntityManager, evt: OutboxWrite): Promise<void> {
    const row = em.create(OutboxEvent, {
      topic: evt.topic,
      type: evt.type,
      aggregateType: evt.aggregateType,
      aggregateId: evt.aggregateId,
      payload: evt.payload,
      status: OUTBOX_STATUS.PENDING,
    });
    await em.save(row);
  }

  /**
   * Claim + publish one batch. Returns the number of dispatched rows.
   * Safe to run concurrently across instances (SKIP LOCKED) and safe to
   * re-run after crashes (stale PROCESSING rows are re-claimed).
   */
  async relayOnce(): Promise<number> {
    const claimed = await this.dataSource.transaction(async (em) => {
      const staleCutoff = new Date(Date.now() - PROCESSING_STALE_MS);
      const rows = await em
        .createQueryBuilder(OutboxEvent, 'o')
        .where('o.status = :pending', { pending: OUTBOX_STATUS.PENDING })
        .orWhere(
          'o.status = :processing AND o.updatedAt < :cutoff',
          { processing: OUTBOX_STATUS.PROCESSING, cutoff: staleCutoff },
        )
        .orderBy('o.createdAt', 'ASC')
        .take(BATCH_SIZE)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (rows.length === 0) return [];
      await em
        .update(
          OutboxEvent,
          { id: In(rows.map((r) => r.id)) },
          { status: OUTBOX_STATUS.PROCESSING },
        )
        ;
      return rows;
    });

    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      await this.dispatch(row);
    }
    return claimed.length;
  }

  private async dispatch(row: OutboxEvent): Promise<void> {
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
      await this.outboxRepo.update(row.id, {
        status: OUTBOX_STATUS.PUBLISHED,
        publishedAt: new Date(),
        lastError: null,
      });
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= this.maxAttempts;
      await this.outboxRepo
        .update(row.id, {
          attempts,
          lastError: (err as Error).message.slice(0, 500),
          status: dead ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING,
        })
        .catch(() => undefined);
      this.logger.error(
        `outbox dispatch failed (${attempts}/${this.maxAttempts}) ` +
          `event=${row.type} agg=${row.aggregateId}: ${(err as Error).message}`,
      );
    }
  }

  /** Build a canonical event envelope for logging/debug tooling. */
  static envelopeId(): string {
    return randomUUID();
  }
}
