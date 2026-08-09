import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER';

/**
 * Redis infrastructure module.
 * Two dedicated clients: primary (app) + publisher (WS fan-out).
 * ioredis can be shared across instances (geo, pub/sub, caching, BullMQ).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('redis.host', 'localhost');
        const port = config.get<number>('redis.port', 6379);
        const password = config.get<string>('redis.password');
        const tls = config.get<boolean>('redis.tls', false);
        const client = new Redis({
          host,
          port,
          password,
          tls: tls ? {} : undefined,
          lazyConnect: true,
          maxRetriesPerRequest: null,
        });
        client.on('error', (err) =>
          console.error('[redis] client error', err.message),
        );
        return client;
      },
    },
    {
      provide: REDIS_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('redis.host', 'localhost');
        const port = config.get<number>('redis.port', 6379);
        const password = config.get<string>('redis.password');
        const tls = config.get<boolean>('redis.tls', false);
        const client = new Redis({
          host,
          port,
          password,
          tls: tls ? {} : undefined,
          lazyConnect: true,
          maxRetriesPerRequest: null,
        });
        client.on('error', (err) =>
          console.error('[redis] publisher error', err.message),
        );
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT, REDIS_PUBLISHER],
})
export class RedisModule {}
