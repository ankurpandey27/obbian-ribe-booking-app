import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PartitionMaintenanceService } from './partition-maintenance.service';

/**
 * Database module — single Postgres instance (monolith), PostGIS enabled.
 * Entities are registered per module; migrations live in /migrations.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host', 'localhost'),
        port: config.get<number>('database.port', 5432),
        username: config.get<string>('database.user', 'postgres'),
        password: config.get<string>('database.password', 'postgres'),
        database: config.get<string>('database.name', 'ride_booking'),
        autoLoadEntities: true,
        synchronize:
          config.get<string>('server.env') === 'development' ? false : false,
        migrations: ['dist/migrations/*.js'],
        migrationsRun: true,
        logging:
          config.get<string>('server.env') === 'development'
            ? ['error', 'warn']
            : ['error'],
        ssl: config.get<string>('server.env') === 'production',
        extra: { max: 2 }, // boot-time migration DS: tiny pool; prod uses Drizzle
      }),
    }),
  ],
  providers: [PartitionMaintenanceService],
  exports: [PartitionMaintenanceService],
})
export class DatabaseModule {}
