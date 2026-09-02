import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { areaType } from './enums';

/**
 * GEO DOMAIN — future `pricing-svc` / `geo-svc`.
 *
 * `areas.boundary` is a PostGIS `geography(Polygon,4326)` column created in
 * migration 009. Drizzle has no first-class geography type, so it is declared
 * as `text` for typing and always read/written through `ST_*` in raw
 * parameterised SQL (see ZonesService). Never string-concatenate into those calls.
 */

/** Geofenced areas driving operational rules (airports, restricted zones, surge). */
export const areas = pgTable(
  'areas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Stable key referenced by config/rules, e.g. hyd-airport. */
    slug: varchar('slug', { length: 96 }).notNull().unique(),
    areaType: areaType('areaType').notNull(),
    city: varchar('city', { length: 50 }).notNull(),
    boundary: text('boundary').notNull(),
    surchargePaise: integer('surchargePaise').notNull().default(0),
    minSurgeMultiplier: numeric('minSurgeMultiplier', {
      precision: 3,
      scale: 2,
      mode: 'number',
    }),
    isRestricted: boolean('isRestricted').notNull().default(false),
    restrictionMessage: text('restrictionMessage'),
    /** Higher wins when polygons overlap. */
    priority: smallint('priority').notNull().default(0),
    isActive: boolean('isActive').notNull().default(true),
    createdAt: timestamp('createdAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('IDX_areas_city_type')
      .on(t.city, t.areaType)
      .where(sql`"isActive" = true`),
    index('IDX_areas_priority').on(t.priority),
  ],
);

/**
 * Surge audit trail — one row per (city, H3 cell, computation tick). Persisted
 * (not just Redis) because regulators and riders ask "why was I surged at
 * 18:40 on Tuesday", and it is the training set for predictive surge.
 * RANGE-partitioned by `computedAt` (monthly) in migration 010.
 */
export const surgeZonesHistory = pgTable(
  'surge_zones_history',
  {
    id: uuid('id').defaultRandom(),
    city: varchar('city', { length: 50 }).notNull(),
    /** H3 resolution-8 cell index. */
    h3Cell: varchar('h3Cell', { length: 20 }).notNull(),
    surgeMultiplier: numeric('surgeMultiplier', {
      precision: 3,
      scale: 2,
      mode: 'number',
    }).notNull(),
    demandCount: integer('demandCount').notNull().default(0),
    supplyCount: integer('supplyCount').notNull().default(0),
    demandSupplyRatio: numeric('demandSupplyRatio', {
      precision: 8,
      scale: 3,
      mode: 'number',
    })
      .notNull()
      .default(0),
    computedAt: timestamp('computedAt', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('IDX_surge_history_cell_time').on(t.h3Cell, t.computedAt),
    index('IDX_surge_history_city_time').on(t.city, t.computedAt),
    // One row per cell per tick; makes the writer idempotent on retry.
    uniqueIndex('UQ_surge_history_cell_tick').on(t.h3Cell, t.computedAt),
  ],
);
