import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 010 — Partition the high-volume append-only tables + add hot-path indexes.
 *
 * SCOPE DECISION (deliberate, see ADR-011):
 * Only `ride_route_points` and `surge_zones_history` are partitioned here. Both
 * were created empty in migrations 007/009, so converting them is instant.
 *
 * `rides` and `payments` are NOT partitioned by this migration even though they
 * will eventually need it. Converting a populated table to a partitioned parent
 * requires a full table rewrite under an ACCESS EXCLUSIVE lock — minutes of
 * total downtime on a live dataset. `migrationsRun: true` means this file
 * executes during app boot, which is exactly the wrong place for that. It is
 * scheduled as an operator-run maintenance task instead
 * (docs/runbooks/partition-rides.md). What ships here for those two tables is
 * the index work, which is the actual near-term bottleneck at 5M users.
 *
 * Retention becomes DROP PARTITION (instant, no bloat, no vacuum storm) rather
 * than a multi-million-row DELETE.
 */
export class PartitioningAndIndexes1700000000009 implements MigrationInterface {
  name = 'PartitioningAndIndexes1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ================================================================
    // 1. Partition maintenance helper
    // ================================================================
    // Creates the partition covering a given date if it is missing. Called by
    // the migration below for the initial window and thereafter by
    // PartitionMaintenanceService on a daily cron, so a missing partition can
    // never cause an insert to fail.
    //
    // SECURITY: format() with %I/%L quotes identifiers and literals properly —
    // this is parameterised DDL, not string concatenation.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ensure_time_partition(
        parent_table text,
        partition_key timestamptz,
        granularity text DEFAULT 'day'
      ) RETURNS text AS $$
      DECLARE
        range_start timestamptz;
        range_end   timestamptz;
        suffix      text;
        child_name  text;
      BEGIN
        IF granularity = 'month' THEN
          range_start := date_trunc('month', partition_key);
          range_end   := range_start + interval '1 month';
          suffix      := to_char(range_start, 'YYYY_MM');
        ELSE
          range_start := date_trunc('day', partition_key);
          range_end   := range_start + interval '1 day';
          suffix      := to_char(range_start, 'YYYY_MM_DD');
        END IF;

        child_name := parent_table || '_p' || suffix;

        IF NOT EXISTS (
          SELECT 1 FROM pg_class WHERE relname = child_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            child_name, parent_table, range_start, range_end
          );
        END IF;

        RETURN child_name;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Drops partitions whose entire range is older than the retention cutoff.
    // Returns the list of dropped children so the caller can log them.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION drop_old_partitions(
        parent_table text,
        older_than timestamptz
      ) RETURNS SETOF text AS $$
      DECLARE
        child record;
        bound_end timestamptz;
      BEGIN
        FOR child IN
          SELECT c.relname,
                 pg_get_expr(c.relpartbound, c.oid) AS bound
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
           WHERE p.relname = parent_table
        LOOP
          -- Bound text looks like: FOR VALUES FROM ('..') TO ('..')
          bound_end := (
            regexp_match(child.bound, $re$TO \\('([^']+)'\\)$re$)
          )[1]::timestamptz;

          IF bound_end IS NOT NULL AND bound_end <= older_than THEN
            EXECUTE format('DROP TABLE IF EXISTS %I', child.relname);
            RETURN NEXT child.relname;
          END IF;
        END LOOP;
        RETURN;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // ================================================================
    // 2. ride_route_points → RANGE partitioned by recordedAt (daily)
    // ================================================================
    // Table was created empty in 007. Guard on the presence of a partition
    // descriptor so a re-run is a no-op rather than data loss.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ride_route_points' AND relkind = 'r')
           AND NOT EXISTS (SELECT 1 FROM pg_partitioned_table pt
                             JOIN pg_class c ON c.oid = pt.partrelid
                            WHERE c.relname = 'ride_route_points')
        THEN
          -- Refuse to silently discard rows if this ever runs on a populated DB.
          IF (SELECT count(*) FROM ride_route_points) > 0 THEN
            RAISE EXCEPTION
              'ride_route_points is not empty; partition it via the operator runbook, not at boot';
          END IF;

          DROP TABLE ride_route_points;

          CREATE TABLE ride_route_points (
            id uuid NOT NULL DEFAULT gen_random_uuid(),
            "rideId" uuid NOT NULL,
            "driverId" uuid NOT NULL,
            "lat" double precision NOT NULL,
            "lon" double precision NOT NULL,
            "speedKmph" numeric(6,2),
            "headingDegrees" smallint,
            "accuracyMetres" smallint,
            "recordedAt" timestamptz NOT NULL,
            "createdAt" timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (id, "recordedAt")
          ) PARTITION BY RANGE ("recordedAt");

          CREATE INDEX "IDX_ride_route_points_ride_time"
            ON ride_route_points ("rideId", "recordedAt");
          CREATE INDEX "IDX_ride_route_points_driver_time"
            ON ride_route_points ("driverId", "recordedAt");
        END IF;
      END $$;
    `);

    // Pre-create yesterday → +7 days so writes never race the maintenance job.
    await queryRunner.query(`
      DO $$
      DECLARE d int;
      BEGIN
        FOR d IN -1..7 LOOP
          PERFORM ensure_time_partition(
            'ride_route_points', now() + (d || ' days')::interval, 'day'
          );
        END LOOP;
      END $$;
    `);

    // ================================================================
    // 3. surge_zones_history → RANGE partitioned by computedAt (monthly)
    // ================================================================
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'surge_zones_history' AND relkind = 'r')
           AND NOT EXISTS (SELECT 1 FROM pg_partitioned_table pt
                             JOIN pg_class c ON c.oid = pt.partrelid
                            WHERE c.relname = 'surge_zones_history')
        THEN
          IF (SELECT count(*) FROM surge_zones_history) > 0 THEN
            RAISE EXCEPTION
              'surge_zones_history is not empty; partition it via the operator runbook, not at boot';
          END IF;

          DROP TABLE surge_zones_history;

          CREATE TABLE surge_zones_history (
            id uuid NOT NULL DEFAULT gen_random_uuid(),
            "city" varchar(50) NOT NULL,
            "h3Cell" varchar(20) NOT NULL,
            "surgeMultiplier" numeric(3,2) NOT NULL,
            "demandCount" integer NOT NULL DEFAULT 0,
            "supplyCount" integer NOT NULL DEFAULT 0,
            "demandSupplyRatio" numeric(8,3) NOT NULL DEFAULT 0,
            "computedAt" timestamptz NOT NULL,
            PRIMARY KEY (id, "computedAt")
          ) PARTITION BY RANGE ("computedAt");

          -- Partitioned UNIQUE must include the partition key.
          CREATE UNIQUE INDEX "UQ_surge_history_cell_tick"
            ON surge_zones_history ("h3Cell", "computedAt");
          CREATE INDEX "IDX_surge_history_city_time"
            ON surge_zones_history ("city", "computedAt");
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      DECLARE m int;
      BEGIN
        FOR m IN -1..2 LOOP
          PERFORM ensure_time_partition(
            'surge_zones_history', now() + (m || ' months')::interval, 'month'
          );
        END LOOP;
      END $$;
    `);

    // ================================================================
    // 4. Hot-path indexes on rides / payments
    // ================================================================
    // These are the queries that go sequential-scan as the tables grow. Each
    // one backs a specific existing call site:
    //
    //   getActiveRidesForRider  → (riderId, status, createdAt DESC)
    //   getHistoryForRider      → same index, COMPLETED branch
    //   getActiveRideForDriver  → partial (driverId, status) on active states
    //   settlement sweep        → partial (driverId, completedAt) on COMPLETED
    //   matching pickup         → partial (city, status, createdAt) on REQUESTED
    //
    // CREATE INDEX CONCURRENTLY cannot run inside TypeORM's migration
    // transaction, so these are plain CREATE INDEX. They are fast on current
    // data volumes; the runbook covers rebuilding them concurrently if this
    // migration is ever applied to a large live table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_rider_status_created"
        ON rides ("riderId", "status", "createdAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_city_status_created"
        ON rides ("city", "status", "createdAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_driver_active"
        ON rides ("driverId", "status")
        WHERE "status" IN ('ACCEPTED','ARRIVED','IN_PROGRESS')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_settlement_sweep"
        ON rides ("driverId", "completedAt")
        WHERE "status" = 'COMPLETED'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rides_matching_queue"
        ON rides ("city", "createdAt")
        WHERE "status" = 'REQUESTED'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_pending"
        ON payments ("status", "createdAt")
        WHERE "status" IN ('PENDING','PROCESSING')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_rides_due"
        ON scheduled_rides ("status", "scheduledFor")
        WHERE "status" = 'PENDING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scheduled_rides_due"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_pending"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_matching_queue"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_settlement_sweep"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_driver_active"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_city_status_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_rides_rider_status_created"`,
    );

    // Collapse the partitioned tables back to plain tables (data is
    // retention-bound telemetry; recreating empty is the documented behaviour).
    await queryRunner.query(`DROP TABLE IF EXISTS surge_zones_history`);
    await queryRunner.query(`
      CREATE TABLE surge_zones_history (
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
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_surge_history_cell_tick" ON surge_zones_history ("h3Cell", "computedAt")`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS ride_route_points`);
    await queryRunner.query(`
      CREATE TABLE ride_route_points (
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

    await queryRunner.query(
      `DROP FUNCTION IF EXISTS drop_old_partitions(text, timestamptz)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS ensure_time_partition(text, timestamptz, text)`,
    );
  }
}
