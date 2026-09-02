import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { rideStopStatus } from './enums';
import { rides, users } from './core';

/**
 * TRIPS DOMAIN — future `trip-svc` (ride detail slice).
 *
 * `ride_route_points` is the highest-volume table in the system
 * (~1 point / 4 s / active ride). It is RANGE-partitioned by `recordedAt`
 * (daily) in migration 010 so retention is `DROP PARTITION`, not a
 * multi-million-row DELETE. Writes are batched off the hot path — the GPS
 * ping itself only touches Redis (AGENTS.md §7).
 */

/**
 * Intermediate stops for multi-destination rides. `stopOrder` is 1-based;
 * the ride's own pickup/dropoff columns remain the first and last legs, so
 * a 0-stop ride behaves exactly as before.
 */
export const rideStops = pgTable(
  'ride_stops',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rideId: uuid('rideId')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    stopOrder: smallint('stopOrder').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    address: varchar('address', { length: 512 }),
    status: rideStopStatus('status').notNull().default('PENDING'),
    /** Drives waitingPaise on the fare. */
    waitingMinutes: integer('waitingMinutes').notNull().default(0),
    arrivedAt: timestamp('arrivedAt', { withTimezone: true }),
    departedAt: timestamp('departedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_ride_stops_ride_order').on(t.rideId, t.stopOrder),
    index('IDX_ride_stops_ride').on(t.rideId),
  ],
);

/**
 * Sampled GPS breadcrumb trail. Purpose: fare disputes ("the driver took a
 * longer route"), safety route-deviation detection, and ETA model training.
 *
 * PARTITIONED BY RANGE (recordedAt) — see migration 010. There is deliberately
 * no FK to rides: a partitioned child cannot carry one cheaply at this write
 * volume, and orphan rows are harmless (they age out with the partition).
 */
export const rideRoutePoints = pgTable(
  'ride_route_points',
  {
    id: uuid('id').defaultRandom(),
    rideId: uuid('rideId').notNull(),
    driverId: uuid('driverId').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    /** km/h derived client-side or from consecutive fixes. */
    speedKmph: numeric('speedKmph', {
      precision: 6,
      scale: 2,
      mode: 'number',
    }),
    headingDegrees: smallint('headingDegrees'),
    /** GPS horizontal accuracy in metres; >50 m points are low-trust. */
    accuracyMetres: smallint('accuracyMetres'),
    recordedAt: timestamp('recordedAt', { withTimezone: true }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Replay a ride's trail in order — the only read pattern that matters.
    index('IDX_ride_route_points_ride_time').on(t.rideId, t.recordedAt),
  ],
);

/**
 * Rich two-way reviews. Distinct from `rides.riderRating`/`driverRating`
 * (which stay as the fast denormalised score): this table carries free text,
 * tags and moderation state, and is what the ratings aggregate is built from.
 */
export const rideReviews = pgTable(
  'ride_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rideId: uuid('rideId')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    fromUserId: uuid('fromUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('toUserId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    comment: text('comment'),
    tags: varchar('tags', { length: 32 }).array(),
    /** Hidden from public aggregates. */
    isFlagged: boolean('isFlagged').notNull().default(false),
    moderationNote: text('moderationNote'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One review per direction per ride.
    uniqueIndex('UQ_ride_reviews_ride_from').on(t.rideId, t.fromUserId),
    // "Show reviews about this user" — excludes flagged rows.
    index('IDX_ride_reviews_to_user')
      .on(t.toUserId, t.createdAt)
      .where(sql`"isFlagged" = false`),
    index('IDX_ride_reviews_flagged')
      .on(t.createdAt)
      .where(sql`"isFlagged" = true`),
  ],
);
