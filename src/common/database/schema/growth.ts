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
import { incentiveStatus, referralStatus, userRole } from './enums';
import { rides, users } from './core';

/**
 * GROWTH DOMAIN — future `growth-svc`.
 * Both tables pay real money, so both are idempotent by UNIQUE constraint
 * rather than by application check-then-act.
 */

/**
 * Referral programme definitions attached to an owning user's code.
 * The code itself is denormalised onto `users.referralCode` for the
 * signup-time lookup; this table holds the reward terms and usage caps.
 */
export const referralCodes = pgTable(
  'referral_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 16 }).notNull().unique(),
    ownerUserId: uuid('ownerUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which side of the marketplace this code recruits. */
    targetRole: userRole('targetRole').notNull().default('RIDER'),
    refereeRewardPaise: integer('refereeRewardPaise').notNull().default(0),
    referrerRewardPaise: integer('referrerRewardPaise').notNull().default(0),
    /** Rides the referee must complete before the reward qualifies. */
    qualifyingRides: integer('qualifyingRides').notNull().default(1),
    maxRedemptions: integer('maxRedemptions').notNull().default(0), // 0 = unlimited
    redemptionCount: integer('redemptionCount').notNull().default(0),
    validFrom: timestamp('validFrom', { withTimezone: true }),
    validUntil: timestamp('validUntil', { withTimezone: true }),
    isActive: boolean('isActive').notNull().default(true),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_referral_codes_owner').on(t.ownerUserId),
    index('IDX_referral_codes_active')
      .on(t.code)
      .where(sql`"isActive" = true`),
  ],
);

/**
 * One row per referred user. The UNIQUE on `refereeUserId` is the anti-abuse
 * core: an account can be referred exactly once, ever, regardless of how many
 * codes it tries.
 */
export const referralRedemptions = pgTable(
  'referral_redemptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    referralCodeId: uuid('referralCodeId')
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'restrict' }),
    referrerUserId: uuid('referrerUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** UNIQUE — one referral per account for life. */
    refereeUserId: uuid('refereeUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    status: referralStatus('status').notNull().default('PENDING'),
    qualifyingRidesCompleted: integer('qualifyingRidesCompleted')
      .notNull()
      .default(0),
    /** Ride that tipped the referee over the qualifying threshold. */
    qualifyingRideId: uuid('qualifyingRideId').references(() => rides.id, {
      onDelete: 'set null',
    }),
    referrerRewardPaise: integer('referrerRewardPaise').notNull().default(0),
    refereeRewardPaise: integer('refereeRewardPaise').notNull().default(0),
    rejectionReason: text('rejectionReason'),
    qualifiedAt: timestamp('qualifiedAt', { withTimezone: true }),
    rewardedAt: timestamp('rewardedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_referral_redemptions_referrer').on(
      t.referrerUserId,
      t.createdAt,
    ),
    // Reward sweep: qualified-but-unpaid.
    index('IDX_referral_redemptions_payout')
      .on(t.status, t.qualifiedAt)
      .where(sql`"status" = 'QUALIFIED'`),
  ],
);

/**
 * Driver incentive targets ("complete 12 rides today → ₹200"). Progress is
 * incremented on ride completion; the payout writes an INCENTIVE_CREDIT
 * ledger entry exactly once, guarded by the PAID status transition.
 */
export const driverIncentives = pgTable(
  'driver_incentives',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    driverId: uuid('driverId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'DAILY_RIDES' | 'WEEKLY_RIDES' | 'PEAK_HOURS' | 'STREAK' … */
    incentiveType: varchar('incentiveType', { length: 32 }).notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    targetRides: integer('targetRides').notNull().default(0),
    completedRides: integer('completedRides').notNull().default(0),
    /** Optional earnings target instead of / alongside a ride count. */
    targetEarningsPaise: integer('targetEarningsPaise').notNull().default(0),
    achievedEarningsPaise: integer('achievedEarningsPaise')
      .notNull()
      .default(0),
    bonusPaise: integer('bonusPaise').notNull().default(0),
    status: incentiveStatus('status').notNull().default('ACTIVE'),
    city: varchar('city', { length: 50 }),
    periodStart: timestamp('periodStart', { withTimezone: true }).notNull(),
    periodEnd: timestamp('periodEnd', { withTimezone: true }).notNull(),
    achievedAt: timestamp('achievedAt', { withTimezone: true }),
    paidAt: timestamp('paidAt', { withTimezone: true }),
    /** Ledger entry that paid this out; proves single payment. */
    ledgerEntryId: uuid('ledgerEntryId'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One target of a given type per driver per period.
    uniqueIndex('UQ_driver_incentives_driver_type_period').on(
      t.driverId,
      t.incentiveType,
      t.periodStart,
    ),
    // Progress bump on ride completion: the driver's live targets.
    index('IDX_driver_incentives_active')
      .on(t.driverId, t.periodEnd)
      .where(sql`"status" = 'ACTIVE'`),
    // Payout sweep.
    index('IDX_driver_incentives_payout')
      .on(t.achievedAt)
      .where(sql`"status" = 'ACHIEVED'`),
  ],
);
