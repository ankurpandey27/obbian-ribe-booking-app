import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from './drizzle.module';

@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);
  private readonly enabled: boolean;
  private readonly precreateDays: number;
  private readonly precreateMonths: number;
  private readonly routeRetentionDays: number;
  private readonly surgeRetentionDays: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('partition.enabled', true);
    this.precreateDays = Math.max(
      1,
      config.get<number>('partition.precreateDays', 7),
    );
    this.precreateMonths = Math.max(
      1,
      config.get<number>('partition.precreateMonths', 2),
    );
    this.routeRetentionDays = Math.max(
      1,
      config.get<number>('tracking.breadcrumbRetentionDays', 90),
    );
    this.surgeRetentionDays = Math.max(
      1,
      config.get<number>('partition.surgeHistoryRetentionDays', 365),
    );
  }

  async run(): Promise<{ created: number; dropped: string[] }> {
    if (!this.enabled) return { created: 0, dropped: [] };
    const [lock] = await this.db.execute(
      sql`SELECT pg_try_advisory_lock(hashtextextended('obbian.partition_maintenance', 0)) AS locked`,
    );
    if (!lock?.locked) return { created: 0, dropped: [] };

    try {
      let created = 0;
      for (let day = 0; day <= this.precreateDays; day += 1) {
        await this.db.execute(sql`
          SELECT ensure_time_partition(
            'ride_route_points', now() + ${day} * interval '1 day', 'day'
          )
        `);
        created += 1;
      }
      for (let month = 0; month <= this.precreateMonths; month += 1) {
        await this.db.execute(sql`
          SELECT ensure_time_partition(
            'surge_zones_history', now() + ${month} * interval '1 month', 'month'
          )
        `);
        created += 1;
      }
      const routeDropped = await this.db.execute(sql`
        SELECT drop_old_partitions(
          'ride_route_points', now() - ${this.routeRetentionDays} * interval '1 day'
        ) AS name
      `);
      const surgeDropped = await this.db.execute(sql`
        SELECT drop_old_partitions(
          'surge_zones_history', now() - ${this.surgeRetentionDays} * interval '1 day'
        ) AS name
      `);
      const dropped = [...routeDropped.rows, ...surgeDropped.rows]
        .map((row) => String((row as { name?: unknown }).name ?? ''))
        .filter(Boolean);
      if (dropped.length > 0)
        this.logger.warn(
          `partition maintenance dropped ${dropped.length} old partitions`,
        );
      return { created, dropped };
    } finally {
      await this.db.execute(
        sql`SELECT pg_advisory_unlock(hashtextextended('obbian.partition_maintenance', 0))`,
      );
    }
  }

  @Cron('0 1 * * *')
  async scheduledRun(): Promise<void> {
    await this.run().catch((err: unknown) =>
      this.logger.error(
        `partition maintenance failed: ${(err as Error).message}`,
      ),
    );
  }
}
