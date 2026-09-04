import { outboxEvents } from '../database/schema';
import { outboxStatus } from '../database/schema/enums';

export const OUTBOX_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
} as const;
export type OutboxStatusValue =
  (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;

export { outboxStatus };
