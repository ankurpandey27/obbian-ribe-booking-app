import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 006 — Driver documents + vehicles (regulatory dispatch gate).
 *
 * WHY: `drivers.licenseNumber` / `vehicleRegistration` were free-text columns
 * with no upload, no verification state and no expiry. An Indian ride-hailing
 * operator may not dispatch a driver whose DL / RC / insurance is unverified or
 * lapsed, so this was a launch blocker, not a nice-to-have.
 *
 * Two structural fixes land here:
 *  1. Vehicles move to their own table. The old 1:1 columns lost history and
 *     broke the UNIQUE on vehicleRegistration every time a captain swapped
 *     vehicles — a routine event we were treating as a conflict.
 *  2. `drivers.isComplianceVerified` becomes the single flag matching reads,
 *     kept true only while every required document is VERIFIED and unexpired.
 *
 * Backfill policy: existing drivers are migrated with their current
 * registration as an ACTIVE vehicle and isComplianceVerified = false. They must
 * pass document review before dispatch resumes. This is deliberate — silently
 * grandfathering unverified drivers would defeat the gate.
 */
export class DriverCompliance1700000000005 implements MigrationInterface {
  name = 'DriverCompliance1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- enums ----------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE driver_document_type AS ENUM (
          'DRIVING_LICENSE','VEHICLE_REGISTRATION','VEHICLE_INSURANCE',
          'VEHICLE_FITNESS','VEHICLE_PERMIT','POLLUTION_CERTIFICATE',
          'AADHAAR','PAN','PROFILE_PHOTO','BANK_PROOF'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE document_status AS ENUM (
          'PENDING','IN_REVIEW','VERIFIED','REJECTED','EXPIRED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ---------- driver_vehicles ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_vehicles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "registrationNumber" varchar(32) NOT NULL UNIQUE,
        "vehicleType" ride_type NOT NULL,
        "make" varchar(64),
        "model" varchar(64),
        "color" varchar(32),
        "manufactureYear" integer,
        "seatingCapacity" integer,
        "insuranceExpiresAt" timestamptz,
        "fitnessExpiresAt" timestamptz,
        "permitExpiresAt" timestamptz,
        "pucExpiresAt" timestamptz,
        "isVerified" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        "retiredAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_vehicles_driver" ON driver_vehicles ("driverId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_vehicles_expiry" ON driver_vehicles ("insuranceExpiresAt") WHERE "isActive" = true`,
    );

    // ---------- driver_documents ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS driver_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "vehicleId" uuid REFERENCES driver_vehicles(id) ON DELETE CASCADE,
        "documentType" driver_document_type NOT NULL,
        "status" document_status NOT NULL DEFAULT 'PENDING',
        "storageKey" varchar(512) NOT NULL,
        "documentNumber" varchar(64),
        "issuedAt" timestamptz,
        "expiresAt" timestamptz,
        "verifiedBy" uuid REFERENCES users(id) ON DELETE SET NULL,
        "verifiedAt" timestamptz,
        "rejectionReason" text,
        "submissionCount" integer NOT NULL DEFAULT 1,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        -- A rejection without a reason is unactionable for the driver.
        CONSTRAINT "CHK_driver_documents_rejection_reason"
          CHECK ("status" <> 'REJECTED' OR "rejectionReason" IS NOT NULL)
      )
    `);
    // One LIVE document per slot. Superseded rows stay as REJECTED/EXPIRED
    // history, so the partial predicate is what makes re-upload possible.
    // NULLS NOT DISTINCT: person-scoped docs have vehicleId IS NULL and must
    // still collide with each other (default NULL-distinct would let a driver
    // hold unlimited pending driving licences).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_documents_live_slot"
        ON driver_documents ("driverId", "documentType", "vehicleId")
        NULLS NOT DISTINCT
        WHERE "status" IN ('PENDING','IN_REVIEW','VERIFIED')
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_documents_driver_status" ON driver_documents ("driverId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_documents_review_queue" ON driver_documents ("createdAt") WHERE "status" IN ('PENDING','IN_REVIEW')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_documents_expiry" ON driver_documents ("expiresAt") WHERE "status" = 'VERIFIED' AND "expiresAt" IS NOT NULL`,
    );

    // ---------- drivers: compliance gate columns ----------
    await queryRunner.query(`
      ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS "isComplianceVerified" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "complianceCheckedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "activeVehicleId" uuid
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE drivers
          ADD CONSTRAINT "FK_drivers_activeVehicle"
          FOREIGN KEY ("activeVehicleId") REFERENCES driver_vehicles(id)
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Backfill: existing registration becomes an ACTIVE (unverified) vehicle.
    await queryRunner.query(`
      INSERT INTO driver_vehicles
        ("driverId", "registrationNumber", "vehicleType", "model", "color", "isVerified", "isActive")
      SELECT d."userId", d."vehicleRegistration", d."vehicleType",
             d."vehicleModel", d."vehicleColor", false, true
        FROM drivers d
       WHERE d."vehicleRegistration" IS NOT NULL
       ON CONFLICT ("registrationNumber") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE drivers d
         SET "activeVehicleId" = v.id
        FROM driver_vehicles v
       WHERE v."driverId" = d."userId"
         AND v."registrationNumber" = d."vehicleRegistration"
         AND d."activeVehicleId" IS NULL
    `);

    // Matching hot path: ONLINE + compliant + vehicle type in one index scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_drivers_matchable"
        ON drivers ("status", "vehicleType")
        WHERE "status" = 'ONLINE' AND "isComplianceVerified" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_drivers_matchable"`);
    await queryRunner.query(
      `ALTER TABLE drivers DROP CONSTRAINT IF EXISTS "FK_drivers_activeVehicle"`,
    );
    await queryRunner.query(`
      ALTER TABLE drivers
        DROP COLUMN IF EXISTS "activeVehicleId",
        DROP COLUMN IF EXISTS "complianceCheckedAt",
        DROP COLUMN IF EXISTS "isComplianceVerified"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS driver_documents`);
    await queryRunner.query(`DROP TABLE IF EXISTS driver_vehicles`);
    await queryRunner.query(`DROP TYPE IF EXISTS document_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS driver_document_type`);
  }
}
