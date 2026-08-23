import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 003 — Scale readiness:
 *  1. Composite indexes for the hot ride queries (rider/driver + status
 *     scans run on every poll, history load and fraud check).
 *  2. Transactional outbox table — durable event log written in the same
 *     transaction as ride state changes; relayed to the broker async.
 */
export class PerformanceIndexesAndOutbox1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Hot path: active-rides / history / fraud velocity (riderId prefix).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rides_rider_status_created"
      ON "rides" ("riderId", "status", "createdAt" DESC)
    `);
    // Hot path: driver-side active ride lookups + driver history.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rides_driver_status_created"
      ON "rides" ("driverId", "status", "createdAt" DESC)
    `);
    // Analytics / settlement time-range scans.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_rides_created_at"
      ON "rides" ("createdAt")
    `);

    await queryRunner.query(`
      CREATE TYPE "outbox_status" AS ENUM
        ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')
    `);
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "topic" varchar(100) NOT NULL,
        "type" varchar(100) NOT NULL,
        "aggregateType" varchar(50) NOT NULL,
        "aggregateId" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "lastError" text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NULL
      )
    `);
    // Relay scan: claim oldest pending rows; partial index stays tiny
    // because published rows age out of it.
    await queryRunner.query(`
      CREATE INDEX "idx_outbox_dispatch"
      ON "outbox_events" ("createdAt")
      WHERE "status" IN ('PENDING', 'PROCESSING')
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_outbox_aggregate"
      ON "outbox_events" ("aggregateType", "aggregateId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_events"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "outbox_status"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_rides_rider_status_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_rides_driver_status_created"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_rides_created_at"`);
  }
}
