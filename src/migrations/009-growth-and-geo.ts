import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 009 — Referrals, driver incentives, PostGIS geofenced areas, surge audit.
 *
 * WHY, per gap:
 *  - Growth had no mechanics at all: no referral attribution and no driver
 *    incentive tracking, which are the two levers that actually move supply and
 *    demand in Indian ride-hailing. Both pay real money, so both are made
 *    idempotent by UNIQUE constraint rather than application check-then-act:
 *    `referral_redemptions.refereeUserId` is UNIQUE (one referral per account,
 *    for life) and `driver_incentives` is UNIQUE per (driver, type, period).
 *  - Operational geography was hard-coded city bounding boxes. `areas` holds
 *    real polygons so airport queues, restricted drop zones and toll corridors
 *    become data instead of deploys.
 *  - Surge multipliers existed only transiently in Redis, so "why was I surged
 *    at 18:40 last Tuesday" was unanswerable to a rider or a regulator, and
 *    there was no training set for predictive surge. `surge_zones_history` is
 *    that record (partitioned in 010).
 *
 * PostGIS: `areas.boundary` is geography(Polygon,4326). It is written and read
 * exclusively through parameterised ST_* calls (ZonesService) — never string
 * interpolation. The GIST index is what makes point-in-polygon lookups on the
 * quote hot path viable.
 */
export class GrowthAndGeo1700000000008 implements MigrationInterface {
  name = 'GrowthAndGeo1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PostGIS ships in the postgis/postgis image; managed providers (Neon,
    // RDS) require the extension to be enabled explicitly.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    // ---------- enums ----------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE area_type AS ENUM (
          'CITY_BOUNDARY','AIRPORT','RAILWAY_STATION','RESTRICTED_PICKUP',
          'RESTRICTED_DROPOFF','SURGE_ZONE','DRIVER_QUEUE','TOLL_ZONE'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE incentive_status AS ENUM (
          'ACTIVE','ACHIEVED','PAID','EXPIRED','CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE referral_status AS ENUM (
          'PENDING','QUALIFIED','REWARDED','REJECTED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ---------- users: owned referral code ----------
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS "referralCode" varchar(16)
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_referral_code" ON users ("referralCode") WHERE "referralCode" IS NOT NULL`,
    );

    // ---------- referral_codes ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(16) NOT NULL UNIQUE,
        "ownerUserId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "targetRole" user_role NOT NULL DEFAULT 'RIDER',
        "refereeRewardPaise" integer NOT NULL DEFAULT 0,
        "referrerRewardPaise" integer NOT NULL DEFAULT 0,
        "qualifyingRides" integer NOT NULL DEFAULT 1,
        "maxRedemptions" integer NOT NULL DEFAULT 0,
        "redemptionCount" integer NOT NULL DEFAULT 0,
        "validFrom" timestamptz,
        "validUntil" timestamptz,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_referral_codes_qualifying"
          CHECK ("qualifyingRides" >= 0),
        CONSTRAINT "CHK_referral_codes_cap"
          CHECK ("maxRedemptions" >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_codes_owner" ON referral_codes ("ownerUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_codes_active" ON referral_codes ("code") WHERE "isActive" = true`,
    );

    // ---------- referral_redemptions ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS referral_redemptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "referralCodeId" uuid NOT NULL REFERENCES referral_codes(id) ON DELETE RESTRICT,
        "referrerUserId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "refereeUserId" uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        "status" referral_status NOT NULL DEFAULT 'PENDING',
        "qualifyingRidesCompleted" integer NOT NULL DEFAULT 0,
        "qualifyingRideId" uuid REFERENCES rides(id) ON DELETE SET NULL,
        "referrerRewardPaise" integer NOT NULL DEFAULT 0,
        "refereeRewardPaise" integer NOT NULL DEFAULT 0,
        "rejectionReason" text,
        "qualifiedAt" timestamptz,
        "rewardedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        -- Self-referral is the most common abuse vector; block it in the DB.
        CONSTRAINT "CHK_referral_redemptions_not_self"
          CHECK ("referrerUserId" <> "refereeUserId")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_redemptions_referrer" ON referral_redemptions ("referrerUserId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_referral_redemptions_payout" ON referral_redemptions ("status", "qualifiedAt") WHERE "status" = 'QUALIFIED'`,
    );

    // ---------- driver_incentives ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_incentives (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "incentiveType" varchar(32) NOT NULL,
        "title" varchar(160) NOT NULL,
        "targetRides" integer NOT NULL DEFAULT 0,
        "completedRides" integer NOT NULL DEFAULT 0,
        "targetEarningsPaise" integer NOT NULL DEFAULT 0,
        "achievedEarningsPaise" integer NOT NULL DEFAULT 0,
        "bonusPaise" integer NOT NULL DEFAULT 0,
        "status" incentive_status NOT NULL DEFAULT 'ACTIVE',
        "city" varchar(50),
        "periodStart" timestamptz NOT NULL,
        "periodEnd" timestamptz NOT NULL,
        "achievedAt" timestamptz,
        "paidAt" timestamptz,
        "ledgerEntryId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_driver_incentives_period"
          CHECK ("periodEnd" > "periodStart"),
        -- A PAID incentive must point at the ledger entry that paid it; this is
        -- what proves single payment during reconciliation.
        CONSTRAINT "CHK_driver_incentives_paid_ledger"
          CHECK ("status" <> 'PAID' OR "ledgerEntryId" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_incentives_driver_type_period" ON driver_incentives ("driverId", "incentiveType", "periodStart")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_incentives_active" ON driver_incentives ("driverId", "periodEnd") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_incentives_payout" ON driver_incentives ("achievedAt") WHERE "status" = 'ACHIEVED'`,
    );

    // ---------- areas (PostGIS) ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(120) NOT NULL,
        "slug" varchar(96) NOT NULL UNIQUE,
        "areaType" area_type NOT NULL,
        "city" varchar(50) NOT NULL,
        "boundary" geography(Polygon,4326) NOT NULL,
        "surchargePaise" integer NOT NULL DEFAULT 0,
        "minSurgeMultiplier" numeric(3,2),
        "isRestricted" boolean NOT NULL DEFAULT false,
        "restrictionMessage" text,
        "priority" smallint NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        -- A restriction the rider cannot be told about is a dead end in the UI.
        CONSTRAINT "CHK_areas_restriction_message"
          CHECK ("isRestricted" = false OR "restrictionMessage" IS NOT NULL)
      )
    `);
    // GIST is what makes ST_Contains on the quote path an index scan.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_areas_boundary_gist" ON areas USING GIST ("boundary")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_areas_city_type" ON areas ("city", "areaType") WHERE "isActive" = true`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_areas_priority" ON areas ("priority" DESC)`,
    );

    // ---------- surge_zones_history ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS surge_zones_history (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        "city" varchar(50) NOT NULL,
        "h3Cell" varchar(20) NOT NULL,
        "surgeMultiplier" numeric(3,2) NOT NULL,
        "demandCount" integer NOT NULL DEFAULT 0,
        "supplyCount" integer NOT NULL DEFAULT 0,
        "demandSupplyRatio" numeric(8,3) NOT NULL DEFAULT 0,
        "computedAt" timestamptz NOT NULL
      )
    `);
    // One row per cell per tick — makes the surge writer idempotent on retry.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_surge_history_cell_tick" ON surge_zones_history ("h3Cell", "computedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_surge_history_cell_time" ON surge_zones_history ("h3Cell", "computedAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_surge_history_city_time" ON surge_zones_history ("city", "computedAt" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS surge_zones_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS areas`);
    await queryRunner.query(`DROP TABLE IF EXISTS driver_incentives`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_redemptions`);
    await queryRunner.query(`DROP TABLE IF EXISTS referral_codes`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_referral_code"`);
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS "referralCode"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS referral_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS incentive_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS area_type`);
    // postgis extension is intentionally NOT dropped — other objects may use it.
  }
}
