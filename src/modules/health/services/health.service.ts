import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { DependencyCheckDto, HealthDto } from '../dto/health.dto';

/**
 * HealthService — liveness probe for the API plus its two hard
 * dependencies. Each check fails soft (reported, not thrown) so one
 * degraded dependency never takes the whole endpoint down.
 */
@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthDto> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    return {
      status: database.status === 'ok' && redis.status === 'ok' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database,
      redis,
    };
  }

  private async checkDatabase(): Promise<DependencyCheckDto> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private async checkRedis(): Promise<DependencyCheckDto> {
    const start = Date.now();
    try {
      await this.redis.ping();
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }
}
