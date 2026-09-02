/**
 * Redis injection tokens.
 *
 * These live in their own file, NOT in redis.module.ts, to break a circular
 * import: RedisModule provides GeoService, and GeoService needs the
 * REDIS_CLIENT token. If the token lived on the module, the two files would
 * import each other and Nest would resolve GeoService's dependency as
 * `undefined` at boot ("Nest encountered an undefined dependency").
 *
 * Token-only modules are the standard way out of that cycle — keep it this way.
 */

/** Primary command client: geo, cache, claims, counters. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Pub/sub publish side + Socket.IO adapter pub client. */
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER';

/**
 * Pub/sub subscribe side. A client in subscriber mode cannot issue ordinary
 * commands, so this must never be the primary client.
 */
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';
