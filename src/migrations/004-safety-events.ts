import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NOTE ON THE CLASS NAME: TypeORM validates that every migration class name
 * ends with a JavaScript timestamp and aborts the WHOLE run if one does not.
 * This class was originally `SafetyEvents004`, which failed that check — and
 * because validation happens before execution, it silently blocked migration
 * 003 as well. Neither had ever been applied (no outbox_events / safety_events
 * table existed in any environment). Renaming is safe precisely because it was
 * never applied; the trailing timestamp also fixes ordering.
 */
export class SafetyEvents1700000000003 implements MigrationInterface {
  name = 'SafetyEvents1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS safety_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "rideId" uuid,
        "sessionId" varchar(64),
        "trigger" varchar(32) NOT NULL,
        "locationLat" numeric(10,7),
        "locationLon" numeric(10,7),
        "source" varchar(32) NOT NULL DEFAULT 'rider_app',
        "status" varchar(24) NOT NULL DEFAULT 'OPEN',
        "acknowledgedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_safety_events_created" ON safety_events ("createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_safety_events_user_created" ON safety_events ("userId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_safety_events_open" ON safety_events ("status") WHERE "status" <> 'RESOLVED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_safety_events_open"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_safety_events_user_created"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_safety_events_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS safety_events`);
  }
}
