import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 002 — Scheduled rides: rider books a ride for a future time; a delayed
 * BullMQ job materialises the ride at dispatch time.
 */
export class ScheduledRides1700000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "scheduled_rides" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "riderId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "rideId" uuid NULL REFERENCES "rides"("id") ON DELETE SET NULL,
        "pickupLat" double precision NOT NULL,
        "pickupLon" double precision NOT NULL,
        "dropoffLat" double precision NOT NULL,
        "dropoffLon" double precision NOT NULL,
        "rideType" "ride_type" NOT NULL,
        "city" varchar(50) NOT NULL DEFAULT 'Delhi',
        "scheduledFor" timestamptz NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_scheduled_rides_dispatch"
      ON "scheduled_rides" ("status", "scheduledFor")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_scheduled_rides_rider"
      ON "scheduled_rides" ("riderId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "scheduled_rides"`);
  }
}
