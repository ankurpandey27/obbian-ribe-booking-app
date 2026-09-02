import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export const DRIZZLE_DB = 'DRIZZLE_DB';

export const ANALYTICS_DB = 'ANALYTICS_DB';

/**
 * The primary `pg.Pool` behind {@link DRIZZLE_DB} — for instrumentation only
 * (pool gauges, query timing; see DbMetricsBinder). Do NOT query through it:
 * all data access goes through the Drizzle handle so the schema stays the
 * single source of truth.
 */
export const PG_POOL = 'PG_POOL';

/** Pass `schema` so relational queries are available. */
export type DrizzleDB = NodePgDatabase<typeof schema>;

function createPool(
  config: ConfigService,
  url?: string,
  poolOptions?: { max?: number },
): Pool {
  const urlResolved = url ?? process.env.DATABASE_URL;
  return urlResolved
    ? new Pool({
        connectionString: urlResolved,
        max: poolOptions?.max ?? 20,
        ssl:
          new URL(urlResolved).searchParams.get('sslmode') === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
      })
    : new Pool({
        host: config.get<string>('database.host', 'localhost'),
        port: config.get<number>('database.port', 5432),
        user: config.get<string>('database.user', 'postgres'),
        password: config.get<string>('database.password', 'postgres'),
        database: config.get<string>('database.name', 'ride_booking'),
        max: poolOptions?.max ?? 20,
        ssl:
          config.get<string>('server.env') === 'production'
            ? { rejectUnauthorized: false }
            : undefined,
      });
}

function createDrizzle(pool: Pool): NodePgDatabase<typeof schema> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return drizzle(pool, { schema });
}

/**
 * The SQL-transparent data-access layer (ADR-002). Shares the Postgres
 * instance/credentials with the TypeORM migration runner; all RUNTIME queries
 * go through this handle. Optionally provides a second handle for an
 * analytics read replica.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createPool(config),
    },
    {
      provide: DRIZZLE_DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => createDrizzle(pool),
    },
    {
      provide: ANALYTICS_DB,
      inject: [ConfigService, DRIZZLE_DB],
      useFactory: (config: ConfigService, primary: DrizzleDB) => {
        const url = process.env.ANALYTICS_DATABASE_URL;
        if (!url || url === process.env.DATABASE_URL) {
          /*
           * No separate replica — hand back the PRIMARY HANDLE, never a second
           * pool against the same database. The previous code built one, so
           * every pod held 40 connections while using 20; Postgres
           * connections are a fixed shared resource (`max_connections`) and
           * that waste was a hard ceiling on how far the API could scale out.
           */
          return primary;
        }
        return createDrizzle(createPool(config, url, { max: 10 }));
      },
    },
  ],
  exports: [DRIZZLE_DB, ANALYTICS_DB, PG_POOL],
})
export class DrizzleModule {}
