import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { GeoService } from './geo.service';
import { RedisCircuitBreaker } from './redis-circuit-breaker.service';
import {
  REDIS_CLIENT,
  REDIS_PUBLISHER,
  REDIS_SUBSCRIBER,
} from './redis.constants';

const logger = new Logger('RedisModule');

// Re-exported for backwards compatibility with existing imports. The tokens
// themselves are declared in redis.constants.ts (see the note there).
export { REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER };

/**
 * Redis infrastructure module.
 *
 * Three dedicated clients:
 *  - primary   (commands: geo, cache, claims, counters)
 *  - publisher (pub/sub publish + Socket.IO adapter pub side)
 *  - subscriber (pub/sub subscribe — a client in subscriber mode cannot issue
 *    normal commands, so it MUST be separate from the primary)
 *
 * GeoService is provided here rather than per-feature-module. It is a stateless
 * wrapper over the primary client and was previously duplicated as a provider
 * in drivers/matching/tracking while being ABSENT from pricing — which made
 * SurgeService unresolvable and prevented the application from booting at all.
 * One global instance removes both the duplication and that class of bug.
 */
@Global()
@Module({
  providers: [
    GeoService,
    RedisCircuitBreaker,
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
          logger.error(`client error: ${err.message}`),
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
          logger.error(`publisher error: ${err.message}`),
        );
        return client;
      },
    },
    {
      /**
       * Subscriber connection. A Redis client in subscriber mode may only issue
       * subscribe/unsubscribe, so this cannot share the primary client — the
       * matching claim listener and the Socket.IO adapter both need it.
       */
      provide: REDIS_SUBSCRIBER,
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
          logger.error(`subscriber error: ${err.message}`),
        );
        return client;
      },
    },
  ],
  exports: [
    REDIS_CLIENT,
    REDIS_PUBLISHER,
    REDIS_SUBSCRIBER,
    GeoService,
    RedisCircuitBreaker,
  ],
})
export class RedisModule {}
