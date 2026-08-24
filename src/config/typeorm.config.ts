import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';
import { join } from 'path';

// CLI-only datasource for migration:generate / migration:run / migration:revert.
// The app runtime uses DatabaseModule (dist/migrations, migrationsRun: true).
loadEnv();

// DATABASE_URL (managed providers) wins over individual DB_* vars.
const dbUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : undefined;

export default new DataSource({
  type: 'postgres',
  host: dbUrl?.hostname ?? process.env.DB_HOST ?? 'localhost',
  port: Number(dbUrl?.port || process.env.DB_PORT || 5432),
  username: dbUrl
    ? decodeURIComponent(dbUrl.username)
    : (process.env.DB_USER ?? 'postgres'),
  password: dbUrl
    ? decodeURIComponent(dbUrl.password)
    : (process.env.DB_PASSWORD ?? 'postgres'),
  database: dbUrl
    ? dbUrl.pathname.replace(/^\//, '')
    : (process.env.DB_NAME ?? 'ride_booking'),
  ssl: dbUrl?.searchParams.get('sslmode') === 'require',
  entities: [join(__dirname, '..', 'modules', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],
  synchronize: false,
  logging: ['error', 'warn'],
});
