import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devicePlatform, notificationType } from './enums';
import { users } from './core';

/**
 * ENGAGEMENT DOMAIN — future `notification-svc`.
 * Push tokens live here (not on users) because one account legitimately has
 * several devices, and a dead token must be retired without touching the user.
 */

/**
 * Registered devices for push targeting + force-upgrade decisions.
 * `deviceId` is the app-generated stable install id; the UNIQUE is on
 * `(userId, deviceId)` so re-login on the same handset updates rather than
 * accumulating rows.
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('deviceId', { length: 128 }).notNull(),
    platform: devicePlatform('platform').notNull(),
    /** FCM/APNs token. Nullable: a device may register before granting push. */
    pushToken: varchar('pushToken', { length: 512 }),
    appVersion: varchar('appVersion', { length: 24 }),
    osVersion: varchar('osVersion', { length: 24 }),
    deviceModel: varchar('deviceModel', { length: 64 }),
    /** Preferred locale for templated copy, e.g. en-IN / hi-IN. */
    locale: varchar('locale', { length: 12 }),
    /** false once the provider reports the token as permanently invalid. */
    isPushEnabled: boolean('isPushEnabled').notNull().default(true),
    /** Consecutive push failures; retire the token past the threshold. */
    pushFailureCount: integer('pushFailureCount').notNull().default(0),
    lastActiveAt: timestamp('lastActiveAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('UQ_user_devices_user_device').on(t.userId, t.deviceId),
    // Fan-out target lookup: live push-capable devices for a user.
    index('IDX_user_devices_pushable')
      .on(t.userId)
      .where(sql`"isPushEnabled" = true AND "pushToken" IS NOT NULL`),
    index('IDX_user_devices_token').on(t.pushToken),
  ],
);

/**
 * In-app notification centre. Persisted (not fire-and-forget) so a rider who
 * had no network when their ride completed still sees the receipt.
 * `data` carries the deep-link payload the app routes on.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notificationType: notificationType('notificationType').notNull(),
    title: varchar('title', { length: 160 }).notNull(),
    body: text('body').notNull(),
    /** Deep-link route + params; never raw PII. */
    data: jsonb('data').$type<Record<string, unknown>>(),
    referenceType: varchar('referenceType', { length: 32 }),
    referenceId: uuid('referenceId'),
    readAt: timestamp('readAt', { withTimezone: true }),
    /** Set once at least one device accepted the push. */
    pushedAt: timestamp('pushedAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Notification list — newest first per user.
    index('IDX_notifications_user_created').on(t.userId, t.createdAt),
    // Unread badge count; partial keeps it small as history grows.
    index('IDX_notifications_unread')
      .on(t.userId)
      .where(sql`"readAt" IS NULL`),
  ],
);
