import { Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { InjectRedis } from './redis.decorator';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

const LUA_INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
return {hits, pttl}
`;

/**
 * Cluster-safe rate-limit storage: the in-memory default counts PER INSTANCE,
 * so N replicas behind an LB multiply every client's real limit by N. This
 * storage makes the counters fleet-global via one atomic Lua round-trip.
 */
@Injectable()
export class RedisThrottlerStorage {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  private scriptSha: string | null = null;

  async increment(
    key: string,
    ttl: number,
    _limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const fullKey = `throttle:${key}`;
    let hits: number;
    let pttl: number;

    if (this.scriptSha) {
      const res = (await this.redis.evalsha(
        this.scriptSha,
        1,
        fullKey,
        ttl,
      )) as [number, number];
      [hits, pttl] = res.map(Number);
    } else {
      try {
        this.scriptSha = (await this.redis.script(
          'LOAD',
          LUA_INCREMENT,
        )) as string;
        const res = (await this.redis.evalsha(
          this.scriptSha,
          1,
          fullKey,
          ttl,
        )) as [number, number];
        [hits, pttl] = res.map(Number);
      } catch {
        const res = (await this.redis.eval(LUA_INCREMENT, 1, fullKey, ttl)) as [
          number,
          number,
        ];
        [hits, pttl] = res.map(Number);
      }
    }

    return {
      totalHits: hits,
      timeToExpire: Math.max(pttl, 0),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
