import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  incidentSeverity,
  incidentStatus,
  incidentType,
  cancellationReason,
} from './enums';
import { rides, users } from './core';

/**
 * OPS DOMAIN — future `ops-svc` / admin plane.
 * Nothing here auto-resolves; every terminal state carries a human actor.
 */

/**
 * Rider/driver-reported incidents. Deliberately separate from `safety_events`
 * (which is the real-time SOS intake): incidents are the *case file* opened
 * after the fact, with triage, severity and a resolution audit trail.
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Short human reference quoted in support conversations, e.g. INC-8F3K2Q. */
    reference: varchar('reference', { length: 16 }).notNull().unique(),
    rideId: uuid('rideId').references(() => rides.id, { onDelete: 'set null' }),
    reportedByUserId: uuid('reportedByUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Counterparty the report is about, when applicable. */
    againstUserId: uuid('againstUserId').references(() => users.id, {
      onDelete: 'set null',
    }),
    incidentType: incidentType('incidentType').notNull(),
    severity: incidentSeverity('severity').notNull().default('MEDIUM'),
    status: incidentStatus('status').notNull().default('OPEN'),
    description: text('description').notNull(),
    /** Object-store keys for photos/audio the reporter attached. */
    attachmentKeys: varchar('attachmentKeys', { length: 512 }).array(),
    /** Ops owner; NULL = unassigned queue. */
    assignedToUserId: uuid('assignedToUserId').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolution: text('resolution'),
    /** Goodwill/refund granted while closing, in paise. */
    compensationPaise: integer('compensationPaise').notNull().default(0),
    resolvedByUserId: uuid('resolvedByUserId').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolvedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Ops queue: open work, worst first, then oldest.
    index('IDX_incidents_open_queue')
      .on(t.severity, t.createdAt)
      .where(sql`"status" IN ('OPEN','TRIAGED','INVESTIGATING')`),
    index('IDX_incidents_ride').on(t.rideId),
    index('IDX_incidents_against_user').on(t.againstUserId, t.createdAt),
    index('IDX_incidents_reporter').on(t.reportedByUserId, t.createdAt),
    index('IDX_incidents_assignee')
      .on(t.assignedToUserId, t.status)
      .where(sql`"assignedToUserId" IS NOT NULL`),
  ],
);

/**
 * Cancellation penalty ledger for riders and drivers. Exists so penalties can
 * ESCALATE (the old flat ₹50 taught abusers the ceiling) and so a waiver is an
 * auditable act rather than a silently skipped charge.
 *
 * `offenceIndex` is the count of chargeable cancellations inside the rolling
 * window at the time of charging — the escalation tier key.
 */
export const cancellationPenalties = pgTable(
  'cancellation_penalties',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rideId: uuid('rideId')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    /** 'RIDER' | 'DRIVER' — who bore the penalty. */
    role: varchar('role', { length: 8 }).notNull(),
    reason: cancellationReason('reason').notNull(),
    offenceIndex: integer('offenceIndex').notNull().default(1),
    penaltyPaise: integer('penaltyPaise').notNull().default(0),
    /** Minutes between request and cancellation — the grace-period input. */
    minutesSinceRequest: numeric('minutesSinceRequest', {
      precision: 8,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0),
    isWaived: boolean('isWaived').notNull().default(false),
    waivedReason: text('waivedReason'),
    waivedByUserId: uuid('waivedByUserId').references(() => users.id, {
      onDelete: 'set null',
    }),
    waivedAt: timestamp('waivedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One penalty row per ride per party.
    uniqueIndex('UQ_cancellation_penalties_ride_user').on(t.rideId, t.userId),
    // Rolling-window count for the next escalation tier.
    index('IDX_cancellation_penalties_user_window')
      .on(t.userId, t.createdAt)
      .where(sql`"isWaived" = false`),
  ],
);

/**
 * Inbound webhook dedupe. Razorpay (and the Roju agent bridge) retry
 * aggressively and explicitly do not guarantee once-only delivery; without
 * this table a retried `payment.captured` double-applies.
 *
 * The UNIQUE `(source, eventId)` is the whole mechanism: the handler INSERTs
 * first and treats a conflict as "already processed, ack and return".
 */
export const processedWebhooks = pgTable(
  'processed_webhooks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 'RAZORPAY' | 'ROJU_AGENT' | … */
    source: varchar('source', { length: 32 }).notNull(),
    /** Provider's own event id — the dedupe key. */
    eventId: varchar('eventId', { length: 191 }).notNull(),
    eventType: varchar('eventType', { length: 96 }),
    /** Domain row the event touched, for support lookups. */
    referenceType: varchar('referenceType', { length: 32 }),
    referenceId: uuid('referenceId'),
    /** Trimmed payload snapshot — never secrets/tokens. */
    payloadDigest: varchar('payloadDigest', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    processedAt: timestamp('processedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_processed_webhooks_source_event').on(t.source, t.eventId),
    // Retention sweep.
    index('IDX_processed_webhooks_processed').on(t.processedAt),
  ],
);

/**
 * Admin action audit log. Every privileged mutation (ban, waive, refund,
 * document verdict, DLQ retry) writes one row. Append-only.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actorUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('targetType', { length: 32 }).notNull(),
    targetId: varchar('targetId', { length: 191 }),
    reason: text('reason'),
    /** Redacted before/after snapshot — no PII beyond ids. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    requestId: varchar('requestId', { length: 64 }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_admin_audit_actor_created').on(t.actorUserId, t.createdAt),
    index('IDX_admin_audit_target').on(t.targetType, t.targetId),
    index('IDX_admin_audit_created').on(t.createdAt),
  ],
);

/**
 * Active incident areas affecting routing. When a ride's corridor intersects
 * one of these, the route optimization service triggers a reroute + advisory.
 * TTL-bound: rows auto-expire via Redis TTL on the cache; this table is the
 * durable source for ops dashboards.
 */
export const incidentAreas = pgTable(
  'incident_areas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    incidentId: varchar('incident_id', { length: 64 }),
    areaType: varchar('area_type', { length: 20 })
      .notNull()
      .default('RESTRICTED'), // RESTRICTED, DIVERSION, CONGESTION
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    radiusM: integer('radius_m').notNull().default(500),
    reason: varchar('reason', { length: 256 }),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_incident_areas_active').on(t.isActive),
    index('IDX_incident_areas_location').on(t.lat, t.lon),
  ],
);
