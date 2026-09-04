import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 012 — Shared rides: She-Share & Corporate Pooling.
 *
 * Tables: ride_pools, ride_pool_members, groups, group_members.
 * Enums: pool_status, join_status, group_type, group_role.
 */
export class SharedRides012 implements MigrationInterface {
  name = 'SharedRides012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enums
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS pool_status AS ENUM ('FORMING','LOCKED','DISPATCHED','COMPLETED','CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS join_status AS ENUM ('PENDING','CONFIRMED','REMOVED')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS group_type AS ENUM ('PUBLIC','PRIVATE','COMMUNITY','CORPORATE')`,
    );
    await queryRunner.query(
      `CREATE TYPE IF NOT EXISTS group_role AS ENUM ('ADMIN','MEMBER')`,
    );

    // ride_pools
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_pools (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category_code varchar(32) NOT NULL,
        city varchar(50) NOT NULL,
        status pool_status NOT NULL DEFAULT 'FORMING',
        max_seats integer NOT NULL DEFAULT 4,
        booked_seats integer NOT NULL DEFAULT 0,
        origin_lat double precision NOT NULL,
        origin_lon double precision NOT NULL,
        dest_lat double precision NOT NULL,
        dest_lon double precision NOT NULL,
        corridor_polyline text,
        group_id uuid,
        window_start timestamptz,
        window_end timestamptz,
        total_fare_paise integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_ride_pools_status_city ON ride_pools (status, city)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_ride_pools_group ON ride_pools (group_id)`,
    );

    // ride_pool_members
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_pool_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pool_id uuid NOT NULL REFERENCES ride_pools(id) ON DELETE CASCADE,
        ride_id uuid,
        rider_id varchar(36) NOT NULL,
        seats integer NOT NULL DEFAULT 1,
        share_fare_paise integer NOT NULL DEFAULT 0,
        join_status join_status NOT NULL DEFAULT 'PENDING',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS UQ_pool_member ON ride_pool_members (pool_id, rider_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_pool_members_ride ON ride_pool_members (ride_id)`,
    );

    // groups
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type group_type NOT NULL DEFAULT 'PUBLIC',
        owner_id varchar(36) NOT NULL,
        name varchar(128) NOT NULL,
        city varchar(50),
        is_group_pool_enabled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_groups_owner ON groups (owner_id)`,
    );

    // group_members
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id varchar(36) NOT NULL,
        role group_role NOT NULL DEFAULT 'MEMBER',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS UQ_group_member ON group_members (group_id, user_id)`,
    );

    // ── incident_areas (Module 4) ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS incident_areas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        incident_id varchar(64),
        area_type varchar(20) NOT NULL DEFAULT 'RESTRICTED',
        lat double precision NOT NULL,
        lon double precision NOT NULL,
        radius_m integer NOT NULL DEFAULT 500,
        reason varchar(256),
        is_active boolean NOT NULL DEFAULT true,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_incident_areas_active ON incident_areas (is_active)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_incident_areas_location ON incident_areas (lat, lon)`,
    );

    // ── ride_category_faqs (Module 6) ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_category_faqs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category_code varchar(32) NOT NULL,
        question jsonb NOT NULL DEFAULT '{}'::jsonb,
        answer jsonb NOT NULL DEFAULT '{}'::jsonb,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_faqs_category ON ride_category_faqs (category_code, is_active)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ride_category_faqs`);
    await queryRunner.query(`DROP TABLE IF EXISTS incident_areas`);
    await queryRunner.query(`DROP TABLE IF EXISTS group_members`);
    await queryRunner.query(`DROP TABLE IF NOT EXISTS groups`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_pool_members`);
    await queryRunner.query(`DROP TABLE IF NOT EXISTS ride_pools`);
    await queryRunner.query(`DROP TYPE IF EXISTS group_role`);
    await queryRunner.query(`DROP TYPE IF EXISTS group_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS join_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS pool_status`);
  }
}
