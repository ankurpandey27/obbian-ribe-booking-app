import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.decorator';

const IDEMPOTENCY_TTL_SECONDS = 300;

/**
 * Idempotency interceptor.
 * Apply to mutating endpoints (POST /rides/request, POST /payments/initiate).
 * Client sends `Idempotency-Key: <uuid>` header. Duplicate requests within
 * TTL return the stored response instead of re-executing — prevents
 * double-booking from app retries / double-taps.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const key = request.headers['idempotency-key'] as string | undefined;

    if (!key) {
      return next.handle();
    }

    // Include userId so two different users retrying the same endpoint with
    // the same idempotency key cannot collide (cross-tenant cache leak).
    const userId =
      (request.user as { sub?: string } | undefined)?.sub ?? 'anon';
    const cacheKey = `idempotency:${userId}:${request.method}:${request.originalUrl}:${key}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return of(JSON.parse(cached));
    }

    return next.handle().pipe(
      tap((response) => {
        void this.redis
          .set(
            cacheKey,
            JSON.stringify(response),
            'EX',
            IDEMPOTENCY_TTL_SECONDS,
          )
          .catch(() => undefined);
      }),
    );
  }
}
