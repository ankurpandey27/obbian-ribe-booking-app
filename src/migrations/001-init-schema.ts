import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 001 — Initial schema: PostGIS, enums, 8 tables, Delhi fare seed.
 * Hand-written (not generated) so enum type names and indexes are explicit.
 */
export class InitSchema1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------ PostGIS ------------------------------
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    // ------------------------------ Enums --------------------------------
    await queryRunner.query(
      `CREATE TYPE "user_role" AS ENUM ('RIDER', 'DRIVER', 'ADMIN')`,
    );
    await queryRunner.query(
      `CREATE TYPE "ride_type" AS ENUM ('CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER')`,
    );
    await queryRunner.query(
      `CREATE TYPE "ride_status" AS ENUM ('REQUESTED', 'MATCHING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "driver_status" AS ENUM ('ONLINE', 'OFFLINE', 'ON_RIDE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_method" AS ENUM ('UPI', 'CASH', 'WALLET', 'CARD')`,
    );
    await queryRunner.query(
      `CREATE TYPE "cancellation_reason" AS ENUM ('USER_CANCELLED', 'DRIVER_CANCELLED', 'NO_DRIVER_FOUND', 'SYSTEM')`,
    );

    // ------------------------------ users --------------------------------
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "phoneNumber" varchar(15) NOT NULL UNIQUE,
        "email" varchar NULL,
        "firstName" varchar NULL,
        "lastName" varchar NULL,
        "profileImageUrl" varchar NULL,
        "role" "user_role" NOT NULL DEFAULT 'RIDER',
        "rating" numeric(3,2) NOT NULL DEFAULT 5.0,
        "isVerified" boolean NOT NULL DEFAULT false,
        "lastLoginAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // --------------------------- refresh_tokens --------------------------
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "userId" uuid NOT NULL,
        "tokenHash" varchar(64) NOT NULL UNIQUE,
        "expiresAt" timestamptz NOT NULL,
        "deviceInfo" varchar NULL,
        "revokedAt" timestamptz NULL,
        "rotatedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_userId" ON "refresh_tokens" ("userId")`,
    );

    // --------------------------- saved_locations -------------------------
    await queryRunner.query(`
      CREATE TABLE "saved_locations" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "userId" uuid NOT NULL,
        "label" varchar(50) NOT NULL,
        "lat" double precision NOT NULL,
        "lon" double precision NOT NULL,
        "address" varchar NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_saved_locations_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_locations_userId" ON "saved_locations" ("userId")`,
    );

    // ------------------------------ drivers ------------------------------
    await queryRunner.query(`
      CREATE TABLE "drivers" (
        "userId" uuid PRIMARY KEY,
        "licenseNumber" varchar(50) NOT NULL UNIQUE,
        "vehicleRegistration" varchar(50) NOT NULL UNIQUE,
        "vehicleModel" varchar(100) NULL,
        "vehicleColor" varchar(20) NULL,
        "vehicleType" "ride_type" NOT NULL,
        "status" "driver_status" NOT NULL DEFAULT 'OFFLINE',
        "rating" numeric(3,2) NOT NULL DEFAULT 5.0,
        "totalRides" integer NOT NULL DEFAULT 0,
        "completionRate" numeric(5,2) NOT NULL DEFAULT 100.0,
        "acceptanceRate" numeric(5,2) NOT NULL DEFAULT 100.0,
        "walletBalance" numeric(10,2) NOT NULL DEFAULT 0,
        "bankAccount" varchar(20) NULL,
        "upiId" varchar NULL,
        "lastLocationUpdateAt" timestamptz NULL,
        "onlineSince" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_drivers_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_drivers_status" ON "drivers" ("status")`,
    );

    // ----------------------------- fare_configs --------------------------
    await queryRunner.query(`
      CREATE TABLE "fare_configs" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "city" varchar(50) NOT NULL,
        "rideType" "ride_type" NOT NULL,
        "baseFare" numeric(10,2) NOT NULL DEFAULT 50,
        "perKmRate" numeric(10,2) NOT NULL DEFAULT 10,
        "perMinuteRate" numeric(10,2) NOT NULL DEFAULT 1,
        "surgeMultiplier" numeric(3,2) NOT NULL DEFAULT 1.0,
        "minimumFare" numeric(10,2) NOT NULL DEFAULT 20,
        "commissionRate" numeric(3,2) NOT NULL DEFAULT 0.25,
        "isActive" boolean NOT NULL DEFAULT true,
        CONSTRAINT "UQ_fare_configs_city_rideType" UNIQUE ("city", "rideType")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_fare_configs_city" ON "fare_configs" ("city")`,
    );

    // ------------------------------- rides -------------------------------
    await queryRunner.query(`
      CREATE TABLE "rides" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "riderId" uuid NOT NULL,
        "driverId" uuid NULL,
        "rideType" "ride_type" NOT NULL,
        "status" "ride_status" NOT NULL DEFAULT 'REQUESTED',
        "pickupLat" double precision NOT NULL,
        "pickupLon" double precision NOT NULL,
        "pickupAddress" varchar NULL,
        "dropoffLat" double precision NOT NULL,
        "dropoffLon" double precision NOT NULL,
        "dropoffAddress" varchar NULL,
        "city" varchar(50) NOT NULL DEFAULT 'Delhi',
        "estimatedFare" numeric(10,2) NOT NULL,
        "totalFare" numeric(10,2) NULL,
        "surgeMultiplier" numeric(3,2) NOT NULL DEFAULT 1.0,
        "distanceKm" numeric(10,2) NOT NULL DEFAULT 0,
        "durationMin" integer NOT NULL DEFAULT 0,
        "promoCode" varchar NULL,
        "promoDiscount" numeric(10,2) NOT NULL DEFAULT 0,
        "paymentStatus" "payment_status" NOT NULL DEFAULT 'PENDING',
        "paymentMethod" "payment_method" NOT NULL DEFAULT 'UPI',
        "acceptedAt" timestamptz NULL,
        "arrivedAt" timestamptz NULL,
        "startedAt" timestamptz NULL,
        "completedAt" timestamptz NULL,
        "cancelledAt" timestamptz NULL,
        "cancellationReason" "cancellation_reason" NULL,
        "cancellationFee" numeric(10,2) NOT NULL DEFAULT 0,
        "riderRating" integer NULL,
        "driverRating" integer NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_rides_rider" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_rides_driver" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_riderId" ON "rides" ("riderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_driverId" ON "rides" ("driverId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_status" ON "rides" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_rides_rideType" ON "rides" ("rideType")`,
    );

    // ------------------------------ payments -----------------------------
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "rideId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'INR',
        "status" "payment_status" NOT NULL DEFAULT 'PENDING',
        "method" "payment_method" NOT NULL DEFAULT 'UPI',
        "gateway" varchar(50) NOT NULL DEFAULT 'RAZORPAY',
        "gatewayOrderId" varchar(255) NULL,
        "gatewayPaymentId" varchar(255) NULL,
        "failureReason" varchar NULL,
        "retryCount" integer NOT NULL DEFAULT 0,
        "paidAt" timestamptz NULL,
        "refundedAt" timestamptz NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_payments_ride" FOREIGN KEY ("rideId") REFERENCES "rides"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_payments_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_rideId" ON "payments" ("rideId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_userId" ON "payments" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_gatewayOrderId" ON "payments" ("gatewayOrderId")`,
    );

    // ------------------------------- promos ------------------------------
    await queryRunner.query(`
      CREATE TABLE "promos" (
        "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        "code" varchar(20) NOT NULL UNIQUE,
        "discountPercent" numeric(5,2) NOT NULL,
        "maxDiscount" numeric(10,2) NOT NULL DEFAULT 0,
        "maxUsesPerUser" integer NOT NULL DEFAULT 1,
        "validFrom" timestamptz NULL,
        "validUntil" timestamptz NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // -------------------------- seed: Delhi fares -------------------------
    const fares = [
      ['Delhi', 'CABX_SAVER', 60, 12, 1.5, 1.0, 30, 0.25],
      ['Delhi', 'CABX', 60, 14, 1.5, 1.0, 40, 0.25],
      ['Delhi', 'CABXL', 90, 18, 2.0, 1.0, 60, 0.25],
      ['Delhi', 'COMFORT', 120, 22, 2.5, 1.0, 80, 0.25],
      ['Delhi', 'AUTO', 30, 9, 1.0, 1.0, 20, 0.15],
      ['Delhi', 'TWO_WHEELER', 25, 7, 1.0, 1.0, 15, 0.15],
    ];
    for (const [
      city,
      rideType,
      baseFare,
      perKmRate,
      perMinuteRate,
      surge,
      minimum,
      commission,
    ] of fares) {
      await queryRunner.query(
        `INSERT INTO "fare_configs" ("city", "rideType", "baseFare", "perKmRate", "perMinuteRate", "surgeMultiplier", "minimumFare", "commissionRate")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          city,
          rideType,
          baseFare,
          perKmRate,
          perMinuteRate,
          surge,
          minimum,
          commission,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "promos"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rides"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "fare_configs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "drivers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_locations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "cancellation_reason"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_method"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "driver_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "ride_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "ride_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "user_role"`);
  }
}
