import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { documentStatus, driverDocumentType, rideType } from './enums';
import { users } from './core';

/**
 * COMPLIANCE DOMAIN — future `user-svc` (driver onboarding slice).
 *
 * Regulatory gate: an Indian ride-hailing operator may not dispatch a driver
 * whose DL / RC / insurance is unverified or expired. `drivers.
 * isComplianceVerified` is the fast flag; these tables are the evidence trail.
 */

/**
 * One row per (driver, documentType, vehicle?). Vehicle-scoped documents (RC,
 * insurance, fitness, permit, PUC) carry `vehicleId`; person-scoped ones leave
 * it NULL. The partial UNIQUE index enforces exactly one *live* document per
 * slot while keeping rejected/expired history.
 */
export const driverDocuments = pgTable(
  'driver_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    driverId: uuid('driverId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vehicleId: uuid('vehicleId'),
    documentType: driverDocumentType('documentType').notNull(),
    status: documentStatus('status').notNull().default('PENDING'),
    /** Object-store key, not a public URL — signed on read. */
    storageKey: varchar('storageKey', { length: 512 }).notNull(),
    documentNumber: varchar('documentNumber', { length: 64 }),
    issuedAt: timestamp('issuedAt', { withTimezone: true }),
    /**
     * NULL means "never expires" (PAN, Aadhaar). Non-null is swept nightly:
     * past expiry → EXPIRED → driver loses isComplianceVerified.
     */
    expiresAt: timestamp('expiresAt', { withTimezone: true }),
    verifiedBy: uuid('verifiedBy').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedAt: timestamp('verifiedAt', { withTimezone: true }),
    rejectionReason: text('rejectionReason'),
    submissionCount: integer('submissionCount').notNull().default(1),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One live doc per slot; superseded rows are REJECTED/EXPIRED.
    uniqueIndex('UQ_driver_documents_live_slot')
      .on(t.driverId, t.documentType, t.vehicleId)
      .where(sql`"status" IN ('PENDING','IN_REVIEW','VERIFIED')`),
    index('IDX_driver_documents_driver_status').on(t.driverId, t.status),
    // Ops review queue: oldest pending first.
    index('IDX_driver_documents_review_queue')
      .on(t.createdAt)
      .where(sql`"status" IN ('PENDING','IN_REVIEW')`),
    // Nightly expiry sweep only scans verified docs that can expire.
    index('IDX_driver_documents_expiry')
      .on(t.expiresAt)
      .where(sql`"status" = 'VERIFIED' AND "expiresAt" IS NOT NULL`),
  ],
);

/**
 * Vehicles a driver may operate; replaces the 1:1 registration columns on
 * `drivers`, which lost history (and broke the UNIQUE on
 * vehicleRegistration) on every vehicle swap. `drivers.activeVehicleId`
 * points at the one in service — matching reads vehicleType from THAT row.
 */
export const driverVehicles = pgTable(
  'driver_vehicles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    driverId: uuid('driverId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    registrationNumber: varchar('registrationNumber', { length: 32 })
      .notNull()
      .unique(),
    vehicleType: rideType('vehicleType').notNull(),
    make: varchar('make', { length: 64 }),
    model: varchar('model', { length: 64 }),
    color: varchar('color', { length: 32 }),
    manufactureYear: integer('manufactureYear'),
    seatingCapacity: integer('seatingCapacity'),
    /** Denormalised expiries so the compliance sweep is one table scan. */
    insuranceExpiresAt: timestamp('insuranceExpiresAt', { withTimezone: true }),
    fitnessExpiresAt: timestamp('fitnessExpiresAt', { withTimezone: true }),
    permitExpiresAt: timestamp('permitExpiresAt', { withTimezone: true }),
    pucExpiresAt: timestamp('pucExpiresAt', { withTimezone: true }),
    isVerified: boolean('isVerified').notNull().default(false),
    /** false = retired/sold; kept for ride history integrity. */
    isActive: boolean('isActive').notNull().default(true),
    retiredAt: timestamp('retiredAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_driver_vehicles_driver').on(t.driverId, t.isActive),
    index('IDX_driver_vehicles_expiry')
      .on(t.insuranceExpiresAt)
      .where(sql`"isActive" = true`),
  ],
);
