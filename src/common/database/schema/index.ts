import {
  boolean,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  cancellationReason,
  driverStatus,
  outboxStatus,
  paymentMethod,
  paymentStatus,
  rideStatus,
  rideType,
  userRole,
} from './enums';

/**
 * users + auth + rider profile tables.
 * Column names are camelCase, mirroring the hand-written migrations.
 */

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  phoneNumber: varchar('phoneNumber', { length: 15 }).notNull().unique(),
  email: varchar('email'),
  firstName: varchar('firstName'),
  lastName: varchar('lastName'),
  profileImageUrl: varchar('profileImageUrl'),
  role: userRole('role').notNull().default('RIDER'),
  rating: numeric('rating', { precision: 3, scale: 2, mode: 'number' })
    .notNull()
    .default(5.0),
  isVerified: boolean('isVerified').notNull().default(false),
  lastLoginAt: timestamp('lastLoginAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('tokenHash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    deviceInfo: varchar('deviceInfo'),
    revokedAt: timestamp('revokedAt', { withTimezone: true }),
    rotatedAt: timestamp('rotatedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_refresh_tokens_userId').on(t.userId)],
);

export const savedLocations = pgTable(
  'saved_locations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 50 }).notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    address: varchar('address'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_saved_locations_userId').on(t.userId)],
);

/** Captains (drivers). PK = userId (1:1 with users). */
export const drivers = pgTable(
  'drivers',
  {
    userId: uuid('userId')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    licenseNumber: varchar('licenseNumber', { length: 50 }).notNull().unique(),
    vehicleRegistration: varchar('vehicleRegistration', { length: 50 })
      .notNull()
      .unique(),
    vehicleModel: varchar('vehicleModel', { length: 100 }),
    vehicleColor: varchar('vehicleColor', { length: 20 }),
    vehicleType: rideType('vehicleType').notNull(),
    status: driverStatus('status').notNull().default('OFFLINE'),
    rating: numeric('rating', { precision: 3, scale: 2, mode: 'number' })
      .notNull()
      .default(5.0),
    totalRides: integer('totalRides').notNull().default(0),
    completionRate: numeric('completionRate', {
      mode: 'number',
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default(100.0),
    acceptanceRate: numeric('acceptanceRate', {
      mode: 'number',
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default(100.0),
    walletBalance: numeric('walletBalance', {
      mode: 'number',
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default(0),
    bankAccount: varchar('bankAccount', { length: 20 }),
    upiId: varchar('upiId'),
    lastLocationUpdateAt: timestamp('lastLocationUpdateAt', {
      withTimezone: true,
    }),
    onlineSince: timestamp('onlineSince', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('IDX_drivers_status').on(t.status)],
);

/** Rides — THE state-machine table. */
export const rides = pgTable(
  'rides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    riderId: uuid('riderId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    driverId: uuid('driverId').references(() => users.id, {
      onDelete: 'set null',
    }),
    rideType: rideType('rideType').notNull(),
    status: rideStatus('status').notNull().default('REQUESTED'),
    pickupLat: doublePrecision('pickupLat').notNull(),
    pickupLon: doublePrecision('pickupLon').notNull(),
    pickupAddress: varchar('pickupAddress'),
    dropoffLat: doublePrecision('dropoffLat').notNull(),
    dropoffLon: doublePrecision('dropoffLon').notNull(),
    dropoffAddress: varchar('dropoffAddress'),
    city: varchar('city', { length: 50 }).notNull().default('Delhi'),
    estimatedFare: numeric('estimatedFare', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    totalFare: numeric('totalFare', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }),
    surgeMultiplier: numeric('surgeMultiplier', {
      mode: 'number',
      precision: 3,
      scale: 2,
    })
      .notNull()
      .default(1.0),
    distanceKm: numeric('distanceKm', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0),
    durationMin: integer('durationMin').notNull().default(0),
    promoCode: varchar('promoCode'),
    promoDiscount: numeric('promoDiscount', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0),
    paymentStatus: paymentStatus('paymentStatus').notNull().default('PENDING'),
    paymentMethod: paymentMethod('paymentMethod').notNull().default('UPI'),
    acceptedAt: timestamp('acceptedAt', { withTimezone: true }),
    arrivedAt: timestamp('arrivedAt', { withTimezone: true }),
    startedAt: timestamp('startedAt', { withTimezone: true }),
    completedAt: timestamp('completedAt', { withTimezone: true }),
    cancelledAt: timestamp('cancelledAt', { withTimezone: true }),
    cancellationReason: cancellationReason('cancellationReason'),
    cancellationFee: numeric('cancellationFee', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0),
    riderRating: integer('riderRating'),
    driverRating: integer('driverRating'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_rides_riderId').on(t.riderId),
    index('IDX_rides_driverId').on(t.driverId),
    index('IDX_rides_status').on(t.status),
    index('IDX_rides_rideType').on(t.rideType),
  ],
);

export const scheduledRides = pgTable('scheduled_rides', {
  id: uuid('id').defaultRandom().primaryKey(),
  riderId: uuid('riderId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  rideId: uuid('rideId').references(() => rides.id, { onDelete: 'set null' }),
  pickupLat: doublePrecision('pickupLat').notNull(),
  pickupLon: doublePrecision('pickupLon').notNull(),
  dropoffLat: doublePrecision('dropoffLat').notNull(),
  dropoffLon: doublePrecision('dropoffLon').notNull(),
  rideType: rideType('rideType').notNull(),
  city: varchar('city', { length: 50 }).notNull().default('Delhi'),
  scheduledFor: timestamp('scheduledFor', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('PENDING'),
  createdAt: timestamp('createdAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rideId: uuid('rideId')
      .notNull()
      .references(() => rides.id, { onDelete: 'cascade' }),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: numeric('amount', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    status: paymentStatus('status').notNull().default('PENDING'),
    method: paymentMethod('method').notNull().default('UPI'),
    gateway: varchar('gateway', { length: 50 }).notNull().default('RAZORPAY'),
    gatewayOrderId: varchar('gatewayOrderId', { length: 255 }),
    gatewayPaymentId: varchar('gatewayPaymentId', { length: 255 }),
    failureReason: varchar('failureReason'),
    retryCount: integer('retryCount').notNull().default(0),
    paidAt: timestamp('paidAt', { withTimezone: true }),
    refundedAt: timestamp('refundedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_payments_rideId').on(t.rideId),
    index('IDX_payments_userId').on(t.userId),
    index('IDX_payments_gatewayOrderId').on(t.gatewayOrderId),
  ],
);

export const promos = pgTable('promos', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 20 }).notNull().unique(),
  discountPercent: numeric('discountPercent', {
    precision: 5,
    scale: 2,
    mode: 'number',
  }).notNull(),
  maxDiscount: numeric('maxDiscount', {
    precision: 10,
    scale: 2,
    mode: 'number',
  })
    .notNull()
    .default(0),
  maxUsesPerUser: integer('maxUsesPerUser').notNull().default(1),
  validFrom: timestamp('validFrom', { withTimezone: true }),
  validUntil: timestamp('validUntil', { withTimezone: true }),
  isActive: boolean('isActive').notNull().default(true),
  createdAt: timestamp('createdAt', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const fareConfigs = pgTable(
  'fare_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    city: varchar('city', { length: 50 }).notNull(),
    rideType: rideType('rideType').notNull(),
    baseFare: numeric('baseFare', { precision: 10, scale: 2, mode: 'number' })
      .notNull()
      .default(50),
    perKmRate: numeric('perKmRate', { precision: 10, scale: 2, mode: 'number' })
      .notNull()
      .default(10),
    perMinuteRate: numeric('perMinuteRate', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(1),
    surgeMultiplier: numeric('surgeMultiplier', {
      precision: 3,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(1.0),
    minimumFare: numeric('minimumFare', {
      precision: 10,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(20),
    commissionRate: numeric('commissionRate', {
      precision: 3,
      scale: 2,
      mode: 'number',
    })
      .notNull()
      .default(0.25),
    isActive: boolean('isActive').notNull().default(true),
  },
  (t) => [index('IDX_fare_configs_city').on(t.city)],
);

/** Transactional outbox (see common/events/outbox.entity.ts). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topic: varchar('topic', { length: 100 }).notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    aggregateType: varchar('aggregateType', { length: 50 }).notNull(),
    aggregateId: uuid('aggregateId').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), // jsonb — typed via $type<JSON>
    status: outboxStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('lastError'),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('publishedAt', { withTimezone: true }),
  },
  (t) => [
    index('idx_outbox_dispatch').on(t.status, t.createdAt),
    index('idx_outbox_aggregate').on(t.aggregateType, t.aggregateId),
  ],
);
