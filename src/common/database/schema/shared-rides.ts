import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ── SHARED RIDES (Module 3) ─────────────────────────────────────────────────
// She-Share & Corporate Pooling: ride pools, members, and groups.

export const poolStatus = pgEnum('pool_status', [
  'FORMING',
  'LOCKED',
  'DISPATCHED',
  'COMPLETED',
  'CANCELLED',
]);

export const joinStatus = pgEnum('join_status', [
  'PENDING',
  'CONFIRMED',
  'REMOVED',
]);

export const groupType = pgEnum('group_type', [
  'PUBLIC',
  'PRIVATE',
  'COMMUNITY',
  'CORPORATE',
]);
export const groupRole = pgEnum('group_role', ['ADMIN', 'MEMBER']);

export const ridePools = pgTable(
  'ride_pools',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    categoryCode: varchar('category_code', { length: 32 }).notNull(),
    city: varchar('city', { length: 50 }).notNull(),
    status: poolStatus('status').notNull().default('FORMING'),
    maxSeats: integer('max_seats').notNull().default(4),
    bookedSeats: integer('booked_seats').notNull().default(0),
    // Route corridor: origin/destination cells + polyline
    originLat: doublePrecision('origin_lat').notNull(),
    originLon: doublePrecision('origin_lon').notNull(),
    destLat: doublePrecision('dest_lat').notNull(),
    destLon: doublePrecision('dest_lon').notNull(),
    corridorPolyline: text('corridor_polyline'),
    groupId: uuid('group_id'), // nullable: private/corporate groups
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    totalFarePaise: integer('total_fare_paise').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_ride_pools_status_city').on(t.status, t.city),
    index('IDX_ride_pools_group').on(t.groupId),
  ],
);

export const ridePoolMembers = pgTable(
  'ride_pool_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => ridePools.id, { onDelete: 'cascade' }),
    rideId: uuid('ride_id'), // set once the member's individual ride is created
    riderId: varchar('rider_id', { length: 36 }).notNull(),
    seats: integer('seats').notNull().default(1),
    shareFarePaise: integer('share_fare_paise').notNull().default(0),
    joinStatus: joinStatus('join_status').notNull().default('PENDING'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_pool_member').on(t.poolId, t.riderId),
    index('IDX_pool_members_ride').on(t.rideId),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: groupType('type').notNull().default('PUBLIC'),
    ownerId: varchar('owner_id', { length: 36 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    city: varchar('city', { length: 50 }),
    isGroupPoolEnabled: boolean('is_group_pool_enabled')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_groups_owner').on(t.ownerId)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: varchar('user_id', { length: 36 }).notNull(),
    role: groupRole('role').notNull().default('MEMBER'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('UQ_group_member').on(t.groupId, t.userId)],
);

// ── RIDE CATEGORY FAQs (Module 6 — config-driven smart assistance) ────────
// Developer-defined Q&A per ride category. The AI shows these (never invents
// them); the FE renders them when a category is selected. Managed via
// /admin/catalog/faqs until the CMS exists.

export const rideCategoryFaqs = pgTable(
  'ride_category_faqs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    categoryCode: varchar('category_code', { length: 32 }).notNull(),
    question: jsonb('question').notNull().$type<Record<string, string>>(),
    answer: jsonb('answer').notNull().$type<Record<string, string>>(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_faqs_category').on(t.categoryCode, t.isActive)],
);
