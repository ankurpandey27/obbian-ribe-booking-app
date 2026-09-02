import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { DependencyCheckDto, HealthDto, LivenessDto } from './dto/health.dto';

/**
 * Without a per-dependency deadline, `ioredis` (maxRetriesPerRequest: null)
 * queues commands indefinitely while disconnected, so a ping() against a dead
 * Redis never settles and the probe kills the pod for "not responding" while
 * the real cause is never reported. 2s is well above a healthy round-trip and
 * under any sane probe timeout.
 */
const DEPENDENCY_TIMEOUT_MS = 2000;

/**
 * Liveness/readiness for the API and its two hard dependencies. Every check
 * fails soft AND fast: one degraded dependency never takes the endpoint down
 * or delays it beyond the deadline above.
 */
@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthService.name);
  private shuttingDown = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Readiness fails at the START of shutdown: on SIGTERM, endpoint removal
   * propagates slower than the container stops, so for a second or two traffic
   * still arrives at a process that is closing connections. Failing readiness
   * immediately turns a rolling deploy from "a burst of 502s" into a clean drain.
   */
  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
    this.logger.log(
      'shutdown signalled — readiness now failing to drain traffic',
    );
  }

  /**
   * MUST NOT probe dependencies. Failing liveness on an unreachable Redis
   * would make Kubernetes restart every pod simultaneously — converting a
   * degraded-features incident into a total outage. Dependency state belongs
   * to readiness, which removes a pod from load balancing without killing it.
   */
  liveness(): LivenessDto {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Fails while draining; `degraded` when a hard dependency is unreachable. */
  async readiness(): Promise<HealthDto> {
    if (this.shuttingDown) {
      return {
        status: 'shutting_down',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        // Not probed: the answer is already "no traffic", and a probe during
        // shutdown would hold the pool open while it is being torn down.
        database: { status: 'error', error: 'shutting down' },
        redis: { status: 'error', error: 'shutting down' },
      };
    }
    return this.check();
  }

  async check(): Promise<HealthDto> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    return {
      status:
        database.status === 'ok' && redis.status === 'ok' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database,
      redis,
    };
  }

  private async checkDatabase(): Promise<DependencyCheckDto> {
    return this.timedCheck('database', () => this.dataSource.query('SELECT 1'));
  }

  private async checkRedis(): Promise<DependencyCheckDto> {
    return this.timedCheck('redis', () => this.redis.ping());
  }

  /**
   * The timer is cleared on the success path too — a leaked pending timer
   * keeps the event loop alive and blocks graceful shutdown.
   */
  private async timedCheck(
    name: string,
    probe: () => Promise<unknown>,
  ): Promise<DependencyCheckDto> {
    const start = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`timed out after ${DEPENDENCY_TIMEOUT_MS}ms`)),
            DEPENDENCY_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`${name} health check failed: ${message}`);
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        error: message,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
