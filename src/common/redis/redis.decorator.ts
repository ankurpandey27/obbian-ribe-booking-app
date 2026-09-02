import { Inject } from '@nestjs/common';
import {
  REDIS_CLIENT,
  REDIS_PUBLISHER,
  REDIS_SUBSCRIBER,
} from './redis.constants';

/**
 * Typed injection decorators for the Redis clients.
 *
 * Tokens are imported from redis.constants.ts, not redis.module.ts: importing a
 * decorator must never drag the module in, or the GeoService ↔ RedisModule
 * cycle comes back (see redis.constants.ts).
 */

/** Primary command client: geo, cache, claims, counters. */
export const InjectRedis = () => Inject(REDIS_CLIENT);

/** Pub/sub publish side. */
export const InjectRedisPublisher = () => Inject(REDIS_PUBLISHER);

/**
 * Pub/sub subscribe side. Separate connection by necessity — a client in
 * subscriber mode cannot issue ordinary commands.
 */
export const InjectRedisSubscriber = () => Inject(REDIS_SUBSCRIBER);
