import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/** Injection token for the Drizzle database handle. */
export const DRIZZLE_DB = 'DRIZZLE_DB';

/** Typed handle — pass `schema` so relational queries are available. */
export type DrizzleDB = NodePgDatabase<typeof schema>;

/**
 * DrizzleModule — the SQL-transparent data-access layer (ADR-002).
 * Shares the same Postgres instance/credentials as the TypeORM migration
 * runner; all RUNTIME queries go through this handle.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = process.env.DATABASE_URL;
        const pool = url
          ? new Pool({
              connectionString: url,
              max: 20,
              ssl:
                new URL(url).searchParams.get('sslmode') === 'require'
                  ? { rejectUnauthorized: false }
                  : undefined,
            })
          : new Pool({
              host: config.get<string>('database.host', 'localhost'),
              port: config.get<number>('database.port', 5432),
              user: config.get<string>('database.user', 'postgres'),
              password: config.get<string>('database.password', 'postgres'),
              database: config.get<string>('database.name', 'ride_booking'),
              max: 20,
              ssl:
                config.get<string>('server.env') === 'production'
                  ? { rejectUnauthorized: false }
                  : undefined,
            });
        // Typed-union overload in drizzle's API trips no-unsafe-argument;
        // runtime shape verified by schema.spec.ts.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DrizzleModule {}
