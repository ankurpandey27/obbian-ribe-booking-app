import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.module';

/** Typed injection decorator for the shared Redis client. */
export const InjectRedis = () => Inject(REDIS_CLIENT);
