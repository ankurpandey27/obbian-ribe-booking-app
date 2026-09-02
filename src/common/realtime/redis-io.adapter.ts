import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from '../redis/redis.constants';

/**
 * Makes Socket.IO correct across more than one pod. Nest's default IoAdapter
 * keeps room membership in process memory: the rider's socket and the driver's
 * location usually land on different pods, so `server.to('ride:X').emit(...)`
 * reaches only the emitting pod and the rider's map silently never moves.
 * The Redis adapter relays every room broadcast through pub/sub.
 *
 * The adapter gets DEDICATED clients via .duplicate() rather than the shared
 * REDIS_PUBLISHER/REDIS_SUBSCRIBER: a client in subscriber mode cannot run
 * ordinary commands, and the adapter manages its own channel set — sharing
 * with RideClaimCoordinator would have both fighting over connection state.
 *
 * FALLS BACK, NEVER FAILS: if Redis is unreachable at startup the adapter logs
 * loudly and keeps the in-memory adapter. A single-pod deploy still works;
 * refusing to boot would turn a degraded realtime layer into a total outage.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly config: ConfigService;
  private readonly app: INestApplicationContext;
  private duplicated: Redis[] = [];

  constructor(app: INestApplicationContext) {
    super(app);
    this.app = app;
    this.config = app.get(ConfigService, { strict: false });
  }

  /** Runs once during bootstrap, before any gateway is created. */
  async connect(): Promise<void> {
    const enabled = this.config.get<boolean>(
      'realtime.redisAdapterEnabled',
      true,
    );
    if (!enabled) {
      this.logger.warn(
        'REALTIME_REDIS_ADAPTER_ENABLED=false — Socket.IO rooms are ' +
          'process-local. Cross-pod broadcasts WILL be dropped; only run this ' +
          'with a single instance.',
      );
      return;
    }

    try {
      const pubBase = this.app.get<Redis>(REDIS_PUBLISHER, { strict: false });
      const subBase = this.app.get<Redis>(REDIS_SUBSCRIBER, { strict: false });

      const pubClient = pubBase.duplicate();
      const subClient = subBase.duplicate();
      this.duplicated = [pubClient, subClient];

      // The shared clients are lazyConnect, so the duplicates must connect
      // explicitly — failure here is what triggers the fallback.
      await Promise.all([
        this.ensureConnected(pubClient),
        this.ensureConnected(subClient),
      ]);

      pubClient.on('error', (err) =>
        this.logger.error(`adapter publisher error: ${err.message}`),
      );
      subClient.on('error', (err) =>
        this.logger.error(`adapter subscriber error: ${err.message}`),
      );

      this.adapterConstructor = createAdapter(pubClient, subClient, {
        // Namespaced so this app's broadcasts cannot collide with anything
        // else sharing the Redis instance.
        key: 'obbian:socket.io',
      });
      this.logger.log('Socket.IO Redis adapter active (multi-pod safe)');
    } catch (err) {
      this.logger.error(
        `Socket.IO Redis adapter unavailable, falling back to in-memory ` +
          `rooms (SINGLE-POD ONLY): ${(err as Error).message}`,
      );
      this.adapterConstructor = undefined;
      await this.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all(
      this.duplicated.map((c) => c.quit().catch(() => undefined)),
    );
    this.duplicated = [];
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const origins = this.config
      .get<string>('realtime.corsOrigins', '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: origins.length > 0 ? origins : false,
        credentials: true,
      },
      pingInterval: this.config.get<number>('realtime.pingIntervalMs', 25000),
      pingTimeout: this.config.get<number>('realtime.pingTimeoutMs', 20000),
      // Short resume window so a flaky-network reconnect does not lose
      // room membership.
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false,
      },
    }) as Server;

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === 'ready' || client.status === 'connecting') return;
    await client.connect();
  }
}
