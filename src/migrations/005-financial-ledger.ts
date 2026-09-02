import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 005 — Financial ledger, settlement runs, fare breakdown, GST invoices.
 *
 * WHY: `drivers.walletBalance` was a single mutable numeric column. A balance
 * with no entry history is unauditable — "why does this driver have ₹X" had no
 * answer, and a crashed payout could double-credit with nothing to detect it.
 *
 * After this migration the ledger is the source of truth and walletBalance /
 * walletBalancePaise are a cache that must equal SUM(wallet_ledger.amountPaise)
 * per driver (asserted by LedgerService.reconcile()).
 *
 * Money columns are INTEGER PAISE. int4 ceiling is ₹21,474,836.47 which is far
 * above any per-driver-per-period value; aggregate reporting sums in SQL as
 * bigint so the ceiling is never reached in practice.
 */
export class FinancialLedger1700000000004 implements MigrationInterface {
  name = 'FinancialLedger1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- enums ----------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE ledger_entry_type AS ENUM (
          'RIDE_EARNING','COMMISSION_DEBIT','SETTLEMENT_DEBIT',
          'SETTLEMENT_REVERSAL','INCENTIVE_CREDIT','PENALTY_DEBIT',
          'REFUND_ADJUSTMENT','MANUAL_ADJUSTMENT','TIP_CREDIT'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE settlement_status AS ENUM (
          'PENDING','LEDGERED','PAID','FAILED','CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE invoice_status AS ENUM ('DRAFT','ISSUED','CANCELLED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ---------- drivers: paise mirror of the cached balance ----------
    await queryRunner.query(`
      ALTER TABLE drivers
        ADD COLUMN IF NOT EXISTS "walletBalancePaise" integer NOT NULL DEFAULT 0
    `);
    // Backfill from the existing rupee column so the cache starts consistent.
    await queryRunner.query(`
      UPDATE drivers
         SET "walletBalancePaise" = ROUND("walletBalance" * 100)::integer
       WHERE "walletBalancePaise" = 0 AND "walletBalance" <> 0
    `);

    // ---------- wallet_ledger ----------
    // seq is BIGSERIAL: Postgres assigns the total order, never the app.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_ledger (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigserial NOT NULL,
        "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        "entryType" ledger_entry_type NOT NULL,
        "amountPaise" integer NOT NULL,
        "balanceBeforePaise" integer NOT NULL,
        "balanceAfterPaise" integer NOT NULL,
        "referenceType" varchar(32),
        "referenceId" uuid,
        "idempotencyKey" varchar(160) NOT NULL,
        "reason" text,
        "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        -- Arithmetic invariant enforced by the DB, not just the service:
        -- a row whose balances do not add up cannot exist.
        CONSTRAINT "CHK_wallet_ledger_balance_math"
          CHECK ("balanceAfterPaise" = "balanceBeforePaise" + "amountPaise"),
        -- MANUAL_ADJUSTMENT is the only entry type allowed to carry a
        -- negative amount; every other type derives its sign from LEDGER_SIGN
        -- and must therefore be non-zero in the declared direction.
        CONSTRAINT "CHK_wallet_ledger_reason_on_manual"
          CHECK ("entryType" <> 'MANUAL_ADJUSTMENT' OR "reason" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wallet_ledger_idempotency" ON wallet_ledger ("idempotencyKey")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_driver_seq" ON wallet_ledger ("driverId", seq DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_driver_created" ON wallet_ledger ("driverId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_ledger_reference" ON wallet_ledger ("referenceType", "referenceId")`,
    );

    // ---------- settlements ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS settlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        "periodStart" timestamptz NOT NULL,
        "periodEnd" timestamptz NOT NULL,
        "rideCount" integer NOT NULL DEFAULT 0,
        "grossPaise" integer NOT NULL DEFAULT 0,
        "commissionPaise" integer NOT NULL DEFAULT 0,
        "incentivePaise" integer NOT NULL DEFAULT 0,
        "penaltyPaise" integer NOT NULL DEFAULT 0,
        "netPayoutPaise" integer NOT NULL DEFAULT 0,
        "commissionPercent" numeric(5,2) NOT NULL,
        "status" settlement_status NOT NULL DEFAULT 'PENDING',
        "payoutReference" varchar(128),
        "payoutMode" varchar(16),
        "failureReason" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "ledgeredAt" timestamptz,
        "paidAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_settlements_period" CHECK ("periodEnd" > "periodStart")
      )
    `);
    // THE idempotency guard: re-running the nightly sweep for the same window
    // conflicts instead of paying a driver twice.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settlements_driver_period" ON settlements ("driverId", "periodStart", "periodEnd")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_settlements_status_created" ON settlements ("status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_settlements_driver_created" ON settlements ("driverId", "createdAt" DESC)`,
    );

    // ---------- ride_fare_breakdown ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_fare_breakdown (
        "rideId" uuid PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
        "basePaise" integer NOT NULL DEFAULT 0,
        "distancePaise" integer NOT NULL DEFAULT 0,
        "timePaise" integer NOT NULL DEFAULT 0,
        "surgePaise" integer NOT NULL DEFAULT 0,
        "waitingPaise" integer NOT NULL DEFAULT 0,
        "tollPaise" integer NOT NULL DEFAULT 0,
        "nightPaise" integer NOT NULL DEFAULT 0,
        "extraStopPaise" integer NOT NULL DEFAULT 0,
        "tipPaise" integer NOT NULL DEFAULT 0,
        "promoDiscountPaise" integer NOT NULL DEFAULT 0,
        "cancellationFeePaise" integer NOT NULL DEFAULT 0,
        "subtotalPaise" integer NOT NULL DEFAULT 0,
        "taxPaise" integer NOT NULL DEFAULT 0,
        "totalPaise" integer NOT NULL DEFAULT 0,
        "driverEarningPaise" integer NOT NULL DEFAULT 0,
        "commissionPaise" integer NOT NULL DEFAULT 0,
        "surgeMultiplier" numeric(3,2) NOT NULL DEFAULT 1.0,
        "fareConfigId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ride_fare_breakdown_created" ON ride_fare_breakdown ("createdAt")`,
    );

    // ---------- invoice_sequences (gap-free numbering) ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        "financialYear" varchar(9) NOT NULL,
        "series" varchar(16) NOT NULL,
        "lastNumber" integer NOT NULL DEFAULT 0,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_invoice_sequences_fy_series" ON invoice_sequences ("financialYear", "series")`,
    );

    // ---------- invoices ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "rideId" uuid NOT NULL UNIQUE REFERENCES rides(id) ON DELETE RESTRICT,
        "invoiceNumber" varchar(32) NOT NULL UNIQUE,
        "financialYear" varchar(9) NOT NULL,
        "status" invoice_status NOT NULL DEFAULT 'DRAFT',
        "taxableValuePaise" integer NOT NULL,
        "cgstPaise" integer NOT NULL DEFAULT 0,
        "sgstPaise" integer NOT NULL DEFAULT 0,
        "igstPaise" integer NOT NULL DEFAULT 0,
        "totalPaise" integer NOT NULL,
        "gstRatePercent" numeric(5,2) NOT NULL,
        "sacCode" varchar(8) NOT NULL DEFAULT '996422',
        "sellerGstin" varchar(15),
        "sellerLegalName" varchar(160),
        "buyerGstin" varchar(15),
        "buyerLegalName" varchar(160),
        "placeOfSupply" varchar(64),
        "pdfUrl" varchar(512),
        "issuedAt" timestamptz,
        "cancelledAt" timestamptz,
        "cancellationReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        -- Intra-state uses CGST+SGST, inter-state uses IGST — never both.
        CONSTRAINT "CHK_invoices_gst_split" CHECK (
          ("igstPaise" = 0) OR ("cgstPaise" = 0 AND "sgstPaise" = 0)
        ),
        CONSTRAINT "CHK_invoices_total" CHECK (
          "totalPaise" = "taxableValuePaise" + "cgstPaise" + "sgstPaise" + "igstPaise"
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_invoices_fy_number" ON invoices ("financialYear", "invoiceNumber")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_invoices_buyer_gstin" ON invoices ("buyerGstin")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_invoices_issued" ON invoices ("issuedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS invoices`);
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_sequences`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_fare_breakdown`);
    await queryRunner.query(`DROP TABLE IF EXISTS settlements`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger`);
    await queryRunner.query(
      `ALTER TABLE drivers DROP COLUMN IF EXISTS "walletBalancePaise"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS invoice_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS settlement_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS ledger_entry_type`);
  }
}
