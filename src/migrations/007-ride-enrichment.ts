import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 007 — Multi-stop rides, GPS breadcrumbs, rich reviews, live ETA, fare add-ons.
 *
 * WHY, per gap:
 *  - ETA was computed once at request time and never refreshed, so a rider saw
 *    "20 min" while the driver was two minutes away. `etaMinutes` is now a
 *    separate live column; `durationMin` keeps the original quote so
 *    quote-vs-actual stays auditable.
 *  - Rides supported exactly one pickup and one dropoff. `ride_stops` adds
 *    intermediate legs without changing the shape of a 0-stop ride.
 *  - There was no trail behind a completed ride, so "the driver took a longer
 *    route" and route-deviation safety checks were unanswerable.
 *    `ride_route_points` is that trail (partitioned in 010).
 *  - Ratings were two smallints on rides with no text, tags or moderation.
 *
 * NOTE `ride_route_points` intentionally has NO foreign key to rides: it becomes
 * a partitioned parent in migration 010, and enforcing an FK per row at
 * ~1 insert / 4 s / active ride is a write-amplification cost with no
 * correctness benefit (orphans age out with their partition).
 */
export class RideEnrichment1700000000006 implements MigrationInterface {
  name = 'RideEnrichment1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE ride_stop_status AS ENUM (
          'PENDING','ARRIVED','COMPLETED','SKIPPED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ---------- rides: live ETA + stop count ----------
    await queryRunner.query(`
      ALTER TABLE rides
        ADD COLUMN IF NOT EXISTS "etaMinutes" integer,
        ADD COLUMN IF NOT EXISTS "etaUpdatedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "stopCount" integer NOT NULL DEFAULT 0
    `);

    // ---------- payments: partial-refund support ----------
    await queryRunner.query(`
      ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS "refundedAmountPaise" integer NOT NULL DEFAULT 0
    `);

    // ---------- fare_configs: add-on rates ----------
    // Rupee-denominated to match the sibling columns on this legacy table;
    // converted to paise at read time by PricingService.
    await queryRunner.query(`
      ALTER TABLE fare_configs
        ADD COLUMN IF NOT EXISTS "perExtraStopFare" numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "perWaitingMinuteFare" numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "freeWaitingMinutes" integer NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS "nightSurchargeFare" numeric(10,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "nightStartHour" integer NOT NULL DEFAULT 23,
        ADD COLUMN IF NOT EXISTS "nightEndHour" integer NOT NULL DEFAULT 5
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_fare_configs_lookup"
        ON fare_configs ("city", "rideType") WHERE "isActive" = true
    `);

    // ---------- ride_stops ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_stops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "rideId" uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        "stopOrder" smallint NOT NULL,
        "lat" double precision NOT NULL,
        "lon" double precision NOT NULL,
        "address" varchar(512),
        "status" ride_stop_status NOT NULL DEFAULT 'PENDING',
        "waitingMinutes" integer NOT NULL DEFAULT 0,
        "arrivedAt" timestamptz,
        "departedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ride_stops_order" CHECK ("stopOrder" > 0),
        CONSTRAINT "CHK_ride_stops_lat" CHECK ("lat" BETWEEN -90 AND 90),
        CONSTRAINT "CHK_ride_stops_lon" CHECK ("lon" BETWEEN -180 AND 180)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ride_stops_ride_order" ON ride_stops ("rideId", "stopOrder")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ride_stops_ride" ON ride_stops ("rideId")`,
    );

    // ---------- ride_route_points ----------
    // Plain table here; converted to a RANGE-partitioned parent in 010 so this
    // migration stays reversible on its own.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_route_points (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        "rideId" uuid NOT NULL,
        "driverId" uuid NOT NULL,
        "lat" double precision NOT NULL,
        "lon" double precision NOT NULL,
        "speedKmph" numeric(6,2),
        "headingDegrees" smallint,
        "accuracyMetres" smallint,
        "recordedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ride_route_points_ride_time" ON ride_route_points ("rideId", "recordedAt")`,
    );

    // ---------- ride_reviews ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "rideId" uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        "fromUserId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "toUserId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "rating" smallint NOT NULL,
        "comment" text,
        "tags" varchar(32)[],
        "isFlagged" boolean NOT NULL DEFAULT false,
        "moderationNote" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_ride_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5),
        CONSTRAINT "CHK_ride_reviews_not_self" CHECK ("fromUserId" <> "toUserId")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ride_reviews_ride_from" ON ride_reviews ("rideId", "fromUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ride_reviews_to_user" ON ride_reviews ("toUserId", "createdAt" DESC) WHERE "isFlagged" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ride_reviews_flagged" ON ride_reviews ("createdAt") WHERE "isFlagged" = true`,
    );

    // ---------- users: rating aggregate ----------
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS "ratingCount" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN IF EXISTS "ratingCount"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS ride_reviews`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_route_points`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_stops`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fare_configs_lookup"`);
    await queryRunner.query(`
      ALTER TABLE fare_configs
        DROP COLUMN IF EXISTS "nightEndHour",
        DROP COLUMN IF EXISTS "nightStartHour",
        DROP COLUMN IF EXISTS "nightSurchargeFare",
        DROP COLUMN IF EXISTS "freeWaitingMinutes",
        DROP COLUMN IF EXISTS "perWaitingMinuteFare",
        DROP COLUMN IF EXISTS "perExtraStopFare"
    `);
    await queryRunner.query(
      `ALTER TABLE payments DROP COLUMN IF EXISTS "refundedAmountPaise"`,
    );
    await queryRunner.query(`
      ALTER TABLE rides
        DROP COLUMN IF EXISTS "stopCount",
        DROP COLUMN IF EXISTS "etaUpdatedAt",
        DROP COLUMN IF EXISTS "etaMinutes"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS ride_stop_status`);
  }
}
