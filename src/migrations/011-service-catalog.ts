import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 011 — Service & Ride-Category Catalog.
 *
 * Replaces the hardcoded rideType enum with a DB-backed, city-scoped,
 * localized, icon-bearing catalog that fully drives the FE.
 *
 * Tables: services, ride_categories, ride_category_cities, catalog_versions.
 *
 * Backward compatibility: the 6 legacy ride types (CABX_SAVER, CABX, CABXL,
 * COMFORT, AUTO, TWO_WHEELER) become catalog rows with identical codes so
 * pricing/matching/ledger keep working.
 */
export class ServiceCatalog011 implements MigrationInterface {
  name = 'ServiceCatalog011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── services ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS services (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE,
        display_name jsonb NOT NULL DEFAULT '{}'::jsonb,
        icon_url varchar(512),
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_services_active_sort ON services (is_active, sort_order)`,
    );

    // ── ride_categories ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) NOT NULL UNIQUE,
        service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        display_name jsonb NOT NULL DEFAULT '{}'::jsonb,
        description jsonb DEFAULT '{}'::jsonb,
        icon_url varchar(512),
        thumbnail_url varchar(512),
        capacity integer NOT NULL DEFAULT 4,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        flags jsonb NOT NULL DEFAULT '{}'::jsonb,
        vehicle_class varchar(32),
        eta_factor numeric(4,2) NOT NULL DEFAULT 1.0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_ride_categories_service ON ride_categories (service_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_ride_categories_active_sort ON ride_categories (is_active, sort_order)`,
    );

    // ── ride_category_cities ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ride_category_cities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_category_id uuid NOT NULL REFERENCES ride_categories(id) ON DELETE CASCADE,
        city varchar(50) NOT NULL,
        is_available boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS UQ_ride_category_city ON ride_category_cities (ride_category_id, city)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_ride_category_cities_city ON ride_category_cities (city, is_available)`,
    );

    // ── catalog_versions ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS catalog_versions (
        scope varchar(50) PRIMARY KEY,
        version bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `INSERT INTO catalog_versions (scope, version) VALUES ('global', 1) ON CONFLICT (scope) DO NOTHING`,
    );

    // ── message_catalog (Module 2) ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS message_catalog (
        key varchar(128) PRIMARY KEY,
        scope varchar(50) NOT NULL DEFAULT 'global',
        message jsonb NOT NULL DEFAULT '{}'::jsonb,
        description varchar(256),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ── fare_configs.rideType: enum → varchar (catalog-driven) ──────────────
    // Drop the enum-constrained column type so any catalog code is valid.
    await queryRunner.query(
      `ALTER TABLE fare_configs ALTER COLUMN "rideType" TYPE varchar(32) USING "rideType"::varchar(32)`,
    );

    // ── drivers.vehicleType: enum → varchar (catalog-driven) ────────────────
    await queryRunner.query(
      `ALTER TABLE drivers ALTER COLUMN "vehicleType" TYPE varchar(32) USING "vehicleType"::varchar(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the enum column types.
    await queryRunner.query(
      `ALTER TABLE drivers ALTER COLUMN "vehicleType" TYPE ride_type USING "vehicleType"::text::ride_type`,
    );
    await queryRunner.query(
      `ALTER TABLE fare_configs ALTER COLUMN "rideType" TYPE ride_type USING "rideType"::text::ride_type`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS message_catalog`);
    await queryRunner.query(`DROP TABLE IF EXISTS catalog_versions`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_category_cities`);
    await queryRunner.query(`DROP TABLE IF EXISTS ride_categories`);
    await queryRunner.query(`DROP TABLE IF EXISTS services`);
  }
}
