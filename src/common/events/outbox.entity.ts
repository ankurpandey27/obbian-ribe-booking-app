import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatusValue =
  (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

/**
 * Transactional outbox — the durable bridge between Postgres state changes
 * and the event broker.
 *
 * @deprecated Runtime access now goes through the Drizzle schema
 * (`common/database/schema` → outboxEvents). This TypeORM entity remains
 * only until migration wave 2 completes; do not add new usages.
 */
@Entity('outbox_events')
@Index('idx_outbox_dispatch', ['status', 'createdAt'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Broker topic (see shared/events/topics.ts). */
  @Column({ length: 100 })
  topic: string;

  /** Event type string, e.g. RIDE_ACCEPTED. */
  @Column({ length: 100 })
  type: string;

  /** Owning aggregate, e.g. 'ride' — future microservice routing key. */
  @Column({ length: 50 })
  aggregateType: string;

  /** Aggregate id, doubles as the Kafka partition key. */
  @Column('uuid')
  aggregateId: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Index()
  @Column({
    type: 'enum',
    enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'],
    default: 'PENDING',
  })
  status: OutboxStatusValue;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
