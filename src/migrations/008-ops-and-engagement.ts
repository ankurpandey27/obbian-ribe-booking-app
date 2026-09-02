import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 008 — Incidents, cancellation penalties, webhook dedupe, admin audit,
 *       devices, notifications, account moderation.
 *
 * WHY, per gap:
 *  - Razorpay retries webhooks and does not promise once-only delivery. Without
 *    `processed_webhooks` a retried `payment.captured` double-applies. The
 *    dedupe is a UNIQUE (source, eventId) that the handler INSERTs against
 *    first — conflict means "already handled, ack and return".
 *  - Cancellation fees were a flat ₹50, so abusers learned the ceiling.
 *    `cancellation_penalties` records the rolling offence index that drives an
 *    escalating tier, and makes a waiver an auditable act rather than a
 *    silently skipped charge.
 *  - Safety had SOS intake (`safety_events`) but no case file. `incidents` is
 *    the post-hoc investigation record with triage, severity and resolution.
 *  - Push tokens had nowhere to live, so notifications could not be delivered
 *    and there was no in-app notification history for offline users.
 *  - There was no way to ban or suspend an account, and no audit trail for any
 *    privileged action.
 */
export class OpsAndEngagement1700000000007 implements MigrationInterface {
  name = 'OpsAndEngagement1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- enums ----------
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE incident_type AS ENUM (
          'ACCIDENT','HARASSMENT','FRAUD','PROPERTY_DAMAGE','ROUTE_DEVIATION',
          'OVERCHARGE','VEHICLE_MISMATCH','RUDE_BEHAVIOUR','LOST_ITEM','OTHER'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE incident_status AS ENUM (
          'OPEN','TRIAGED','INVESTIGATING','RESOLVED','DISMISSED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE incident_severity AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE device_platform AS ENUM ('ANDROID','IOS','WEB');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE notification_type AS ENUM (
          'RIDE_UPDATE','PAYMENT','PROMO','SAFETY','INCENTIVE','DOCUMENT',
          'SETTLEMENT','SYSTEM'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE account_status AS ENUM (
          'ACTIVE','SUSPENDED','BANNED','DELETED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ---------- users: moderation ----------
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS "accountStatus" account_status NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN IF NOT EXISTS "suspendedUntil" timestamptz,
        ADD COLUMN IF NOT EXISTS "moderationReason" text
    `);
    // Auth path filters on status; partial keeps the index tiny because the
    // overwhelming majority of rows are ACTIVE.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_account_status"
        ON users ("accountStatus") WHERE "accountStatus" <> 'ACTIVE'
    `);

    // ---------- incidents ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "reference" varchar(16) NOT NULL UNIQUE,
        "rideId" uuid REFERENCES rides(id) ON DELETE SET NULL,
        "reportedByUserId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "againstUserId" uuid REFERENCES users(id) ON DELETE SET NULL,
        "incidentType" incident_type NOT NULL,
        "severity" incident_severity NOT NULL DEFAULT 'MEDIUM',
        "status" incident_status NOT NULL DEFAULT 'OPEN',
        "description" text NOT NULL,
        "attachmentKeys" varchar(512)[],
        "assignedToUserId" uuid REFERENCES users(id) ON DELETE SET NULL,
        "resolution" text,
        "compensationPaise" integer NOT NULL DEFAULT 0,
        "resolvedByUserId" uuid REFERENCES users(id) ON DELETE SET NULL,
        "resolvedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        -- Closing a case requires both an actor and a written resolution.
        CONSTRAINT "CHK_incidents_resolution" CHECK (
          "status" NOT IN ('RESOLVED','DISMISSED')
          OR ("resolution" IS NOT NULL AND "resolvedByUserId" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incidents_open_queue" ON incidents ("severity" DESC, "createdAt") WHERE "status" IN ('OPEN','TRIAGED','INVESTIGATING')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incidents_ride" ON incidents ("rideId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incidents_against_user" ON incidents ("againstUserId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incidents_reporter" ON incidents ("reportedByUserId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_incidents_assignee" ON incidents ("assignedToUserId", "status") WHERE "assignedToUserId" IS NOT NULL`,
    );

    // ---------- cancellation_penalties ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cancellation_penalties (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "rideId" uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        "role" varchar(8) NOT NULL,
        "reason" cancellation_reason NOT NULL,
        "offenceIndex" integer NOT NULL DEFAULT 1,
        "penaltyPaise" integer NOT NULL DEFAULT 0,
        "minutesSinceRequest" numeric(8,2) NOT NULL DEFAULT 0,
        "isWaived" boolean NOT NULL DEFAULT false,
        "waivedReason" text,
        "waivedByUserId" uuid REFERENCES users(id) ON DELETE SET NULL,
        "waivedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_cancellation_penalties_role"
          CHECK ("role" IN ('RIDER','DRIVER')),
        -- A waiver without a reason is indistinguishable from a bug.
        CONSTRAINT "CHK_cancellation_penalties_waiver"
          CHECK ("isWaived" = false OR "waivedReason" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cancellation_penalties_ride_user" ON cancellation_penalties ("rideId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cancellation_penalties_user_window" ON cancellation_penalties ("userId", "createdAt" DESC) WHERE "isWaived" = false`,
    );

    // ---------- processed_webhooks ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "source" varchar(32) NOT NULL,
        "eventId" varchar(191) NOT NULL,
        "eventType" varchar(96),
        "referenceType" varchar(32),
        "referenceId" uuid,
        "payloadDigest" varchar(64),
        "metadata" jsonb,
        "processedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_processed_webhooks_source_event" ON processed_webhooks ("source", "eventId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_processed_webhooks_processed" ON processed_webhooks ("processedAt")`,
    );

    // ---------- admin_audit_log ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "actorUserId" uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        "action" varchar(64) NOT NULL,
        "targetType" varchar(32) NOT NULL,
        "targetId" varchar(191),
        "reason" text,
        "metadata" jsonb,
        "requestId" varchar(64),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_audit_actor_created" ON admin_audit_log ("actorUserId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_audit_target" ON admin_audit_log ("targetType", "targetId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_admin_audit_created" ON admin_audit_log ("createdAt" DESC)`,
    );

    // ---------- user_devices ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "deviceId" varchar(128) NOT NULL,
        "platform" device_platform NOT NULL,
        "pushToken" varchar(512),
        "appVersion" varchar(24),
        "osVersion" varchar(24),
        "deviceModel" varchar(64),
        "locale" varchar(12),
        "isPushEnabled" boolean NOT NULL DEFAULT true,
        "pushFailureCount" integer NOT NULL DEFAULT 0,
        "lastActiveAt" timestamptz NOT NULL DEFAULT now(),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Re-login on the same handset updates instead of accumulating rows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_devices_user_device" ON user_devices ("userId", "deviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_devices_pushable" ON user_devices ("userId") WHERE "isPushEnabled" = true AND "pushToken" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_devices_token" ON user_devices ("pushToken")`,
    );

    // ---------- notifications ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "notificationType" notification_type NOT NULL,
        "title" varchar(160) NOT NULL,
        "body" text NOT NULL,
        "data" jsonb,
        "referenceType" varchar(32),
        "referenceId" uuid,
        "readAt" timestamptz,
        "pushedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_user_created" ON notifications ("userId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_unread" ON notifications ("userId") WHERE "readAt" IS NULL`,
    );

    // ---------- outbox: manual DLQ retry provenance ----------
    await queryRunner.query(`
      ALTER TABLE outbox_events
        ADD COLUMN IF NOT EXISTS "retriedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "retriedBy" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbox_dlq"
        ON outbox_events ("createdAt" DESC) WHERE "status" = 'FAILED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_outbox_dlq"`);
    await queryRunner.query(`
      ALTER TABLE outbox_events
        DROP COLUMN IF EXISTS "retriedBy",
        DROP COLUMN IF EXISTS "retriedAt"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS notifications`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_devices`);
    await queryRunner.query(`DROP TABLE IF EXISTS admin_audit_log`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_webhooks`);
    await queryRunner.query(`DROP TABLE IF EXISTS cancellation_penalties`);
    await queryRunner.query(`DROP TABLE IF EXISTS incidents`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_account_status"`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS "moderationReason",
        DROP COLUMN IF EXISTS "suspendedUntil",
        DROP COLUMN IF EXISTS "accountStatus"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS account_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS notification_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS device_platform`);
    await queryRunner.query(`DROP TYPE IF EXISTS incident_severity`);
    await queryRunner.query(`DROP TYPE IF EXISTS incident_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS incident_type`);
  }
}
