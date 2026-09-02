import {
  bigserial,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { ledgerEntryType, settlementStatus, invoiceStatus } from './enums';
import { rides, users } from './core';

/**
 * FINANCE DOMAIN — future `payments-svc` / `ledger-svc`.
 *
 * Design rule: `drivers.walletBalance` is a CACHE, this ledger is the truth.
 * Every balance mutation writes exactly one immutable row carrying
 * balanceBefore + balanceAfter, so a driver's wallet can be re-derived by
 * replaying entries in `seq` order. Nothing in this file is ever UPDATEd
 * (except settlement lifecycle columns) — corrections are new rows.
 */

/**
 * Append-only wallet ledger. `seq` is a bigserial giving a total order per
 * insert; `(driverId, seq)` is the replay key. Money is stored as INTEGER
 * PAISE — never numeric/float — because this table is the reconciliation
 * source and rounding drift here is unrecoverable.
 */
export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * Monotonic insert order — the replay key. BIGSERIAL, assigned by
     * Postgres (never by the app), so concurrent writers cannot interleave
     * out of order. Declared as bigserial (not bigint) so Drizzle treats it as
     * DB-generated and omits it from INSERT. Safe in JS: the sequence exhausts
     * long after 2^53.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    driverId: uuid('driverId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    entryType: ledgerEntryType('entryType').notNull(),
    /** Signed paise. Sign is derived from entryType via LEDGER_SIGN. */
    amountPaise: integer('amountPaise').notNull(),
    balanceBeforePaise: integer('balanceBeforePaise').notNull(),
    balanceAfterPaise: integer('balanceAfterPaise').notNull(),
    /** Domain row that caused this entry (rideId, settlementId, incentiveId). */
    referenceType: varchar('referenceType', { length: 32 }),
    referenceId: uuid('referenceId'),
    /**
     * Caller-supplied idempotency key. UNIQUE — the same logical credit can
     * never be written twice even if the worker retries after a crash.
     */
    idempotencyKey: varchar('idempotencyKey', { length: 160 })
      .notNull()
      .unique(),
    /** Mandatory for MANUAL_ADJUSTMENT; ops accountability. */
    reason: text('reason'),
    createdBy: uuid('createdBy').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Replay + "my earnings" queries: newest first per driver.
    index('IDX_wallet_ledger_driver_seq').on(t.driverId, t.seq),
    index('IDX_wallet_ledger_driver_created').on(t.driverId, t.createdAt),
    index('IDX_wallet_ledger_reference').on(t.referenceType, t.referenceId),
  ],
);

/**
 * Settlement runs — one row per (driver, period). The UNIQUE index on
 * `(driverId, periodStart, periodEnd)` is what makes the nightly cron
 * idempotent: a re-run of the same window conflicts instead of double-paying.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    driverId: uuid('driverId')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    periodStart: timestamp('periodStart', { withTimezone: true }).notNull(),
    periodEnd: timestamp('periodEnd', { withTimezone: true }).notNull(),
    rideCount: integer('rideCount').notNull().default(0),
    grossPaise: integer('grossPaise').notNull().default(0),
    commissionPaise: integer('commissionPaise').notNull().default(0),
    incentivePaise: integer('incentivePaise').notNull().default(0),
    penaltyPaise: integer('penaltyPaise').notNull().default(0),
    /** gross - commission + incentive - penalty. Stored, not derived. */
    netPayoutPaise: integer('netPayoutPaise').notNull().default(0),
    commissionPercent: numeric('commissionPercent', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }).notNull(),
    status: settlementStatus('status').notNull().default('PENDING'),
    payoutReference: varchar('payoutReference', { length: 128 }),
    payoutMode: varchar('payoutMode', { length: 16 }),
    failureReason: text('failureReason'),
    attempts: integer('attempts').notNull().default(0),
    ledgeredAt: timestamp('ledgeredAt', { withTimezone: true }),
    paidAt: timestamp('paidAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_settlements_driver_period').on(
      t.driverId,
      t.periodStart,
      t.periodEnd,
    ),
    // Retry sweep: "everything not PAID, oldest first".
    index('IDX_settlements_status_created').on(t.status, t.createdAt),
    index('IDX_settlements_driver_created').on(t.driverId, t.createdAt),
  ],
);

/**
 * Per-ride fare breakdown — one row per ride, written at completion.
 * Exists so "why was I charged this?" is answerable without recomputing
 * against config that may since have changed. All paise integers.
 */
export const rideFareBreakdown = pgTable(
  'ride_fare_breakdown',
  {
    rideId: uuid('rideId')
      .primaryKey()
      .references(() => rides.id, { onDelete: 'cascade' }),
    basePaise: integer('basePaise').notNull().default(0),
    distancePaise: integer('distancePaise').notNull().default(0),
    timePaise: integer('timePaise').notNull().default(0),
    /** Surcharge attributable to surge only (fare - fare_at_1x). */
    surgePaise: integer('surgePaise').notNull().default(0),
    waitingPaise: integer('waitingPaise').notNull().default(0),
    tollPaise: integer('tollPaise').notNull().default(0),
    nightPaise: integer('nightPaise').notNull().default(0),
    /** Multi-stop rides charge per extra stop. */
    extraStopPaise: integer('extraStopPaise').notNull().default(0),
    tipPaise: integer('tipPaise').notNull().default(0),
    promoDiscountPaise: integer('promoDiscountPaise').notNull().default(0),
    cancellationFeePaise: integer('cancellationFeePaise').notNull().default(0),
    /** Sum of the above with promo subtracted, floored at minimum fare. */
    subtotalPaise: integer('subtotalPaise').notNull().default(0),
    taxPaise: integer('taxPaise').notNull().default(0),
    totalPaise: integer('totalPaise').notNull().default(0),
    /** Driver take-home for this ride; mirrors the ledger RIDE_EARNING. */
    driverEarningPaise: integer('driverEarningPaise').notNull().default(0),
    commissionPaise: integer('commissionPaise').notNull().default(0),
    surgeMultiplier: numeric('surgeMultiplier', {
      precision: 3,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(1.0),
    /** Snapshot of the fare_config id used, for audit after config edits. */
    fareConfigId: uuid('fareConfigId'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_ride_fare_breakdown_created').on(t.createdAt)],
);

/**
 * GST invoices (India mandate). `invoiceNumber` is gap-free per financial
 * year and generated inside the issuing transaction from `invoice_sequences`
 * — a UNIQUE constraint plus row-level lock, not an application counter.
 * ISSUED rows are immutable; corrections are CANCELLED + re-issued.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rideId: uuid('rideId')
      .notNull()
      .references(() => rides.id, { onDelete: 'restrict' })
      .unique(),
    invoiceNumber: varchar('invoiceNumber', { length: 32 }).notNull().unique(),
    financialYear: varchar('financialYear', { length: 9 }).notNull(),
    status: invoiceStatus('status').notNull().default('DRAFT'),
    /** Pre-tax amount the tax was computed on. */
    taxableValuePaise: integer('taxableValuePaise').notNull(),
    cgstPaise: integer('cgstPaise').notNull().default(0),
    sgstPaise: integer('sgstPaise').notNull().default(0),
    igstPaise: integer('igstPaise').notNull().default(0),
    totalPaise: integer('totalPaise').notNull(),
    gstRatePercent: numeric('gstRatePercent', {
      precision: 5,
      scale: 2,
      mode: 'number',
    }).notNull(),
    /** 996422 = passenger transport by road. */
    sacCode: varchar('sacCode', { length: 8 }).notNull().default('996422'),
    sellerGstin: varchar('sellerGstin', { length: 15 }),
    sellerLegalName: varchar('sellerLegalName', { length: 160 }),
    /** Set only for B2B riders who supplied a GSTIN — enables their ITC. */
    buyerGstin: varchar('buyerGstin', { length: 15 }),
    buyerLegalName: varchar('buyerLegalName', { length: 160 }),
    placeOfSupply: varchar('placeOfSupply', { length: 64 }),
    pdfUrl: varchar('pdfUrl', { length: 512 }),
    issuedAt: timestamp('issuedAt', { withTimezone: true }),
    cancelledAt: timestamp('cancelledAt', { withTimezone: true }),
    cancellationReason: text('cancellationReason'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_invoices_fy_number').on(t.financialYear, t.invoiceNumber),
    index('IDX_invoices_buyer_gstin').on(t.buyerGstin),
    index('IDX_invoices_issued').on(t.issuedAt),
  ],
);

/**
 * Gap-free invoice counters. One row per (financialYear, series); the issuer
 * takes `FOR UPDATE` on this row so concurrent issuance serialises instead
 * of colliding on the invoices UNIQUE index.
 */
export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    financialYear: varchar('financialYear', { length: 9 }).notNull(),
    series: varchar('series', { length: 16 }).notNull(),
    lastNumber: integer('lastNumber').notNull().default(0),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_invoice_sequences_fy_series').on(t.financialYear, t.series),
  ],
);
