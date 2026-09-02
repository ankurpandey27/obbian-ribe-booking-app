import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, map } from 'rxjs';
import type { Request, Response } from 'express';
import { HttpStatus } from '@nestjs/common';
import type { ApiEnvelopeDto } from '../dto/api-envelope.dto';

/**
 * Endpoints that bypass the envelope and return their raw body:
 * - /api/v1/docs, /docs, /api-docs: Swagger serves HTML/JSON docs decoupled
 *   from the app's controllers.
 * - /health (+ /health/live, /health/ready): infrastructure probes. The
 *   readiness endpoint deliberately returns its HealthDto body WITH a 503
 *   status (via @Res passthrough) so operators see WHICH dependency failed —
 *   wrapping would discard that body behind a generic error.
 *
 * Compared against the path WITH the global prefix stripped so it matches
 * regardless of the configured server.apiPrefix.
 */
const SKIP_WRAP_PREFIXES = ['/health', '/api/v1/docs', '/docs', '/api-docs'];

const DEFAULT_MESSAGES: Record<number, string> = {
  [HttpStatus.OK]: 'OK',
  [HttpStatus.CREATED]: 'Created',
  [HttpStatus.ACCEPTED]: 'Accepted',
  [HttpStatus.NO_CONTENT]: 'No Content',
  [HttpStatus.MOVED_PERMANENTLY]: 'Moved Permanently',
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

/**
 * Wraps every HTTP response into the unified API envelope:
 * { success, message, messageCode, data, error, path, requestId, timestamp }.
 *
 * Success (2xx) becomes success:true with the payload in `data`. A handler
 * that directly set an error status (e.g. /health/ready reporting a dead
 * dependency without throwing) is reflected as success:false with an `error`
 * block, so one shape covers both paths.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  private readonly apiPrefix: string;

  constructor(config: ConfigService) {
    this.apiPrefix = config.get<string>('server.apiPrefix', 'api/v1');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Compare skip prefixes against the path WITH the global prefix stripped
    // so it matches regardless of the configured server.apiPrefix.
    const rawPath = request.originalUrl ?? request.url ?? '';
    if (
      SKIP_WRAP_PREFIXES.some((p) => this.stripPrefix(rawPath).startsWith(p))
    ) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        const status = response.statusCode || HttpStatus.OK;
        const requestId = (request.headers['x-request-id'] as string) ?? '';

        const envelope: ApiEnvelopeDto = {
          timestamp: new Date().toISOString(),
          // Keep the full original URL (with prefix) so it matches the error
          // filter and client-side logs verbatim.
          path: rawPath,
          requestId,
          success: status < 400,
          message: this.messageFor(status),
          messageCode: status,
          data: status < 400 ? (data ?? null) : null,
          error:
            status >= 400
              ? {
                  code: DEFAULT_MESSAGES[status] ?? `HTTP_${status}`,
                  message: this.messageFor(status),
                }
              : null,
        };
        return envelope;
      }),
    );
  }

  private stripPrefix(path: string): string {
    // Prefix may be configured as "api/v1" or "/api/v1"; the path always has a
    // leading slash. Normalize so the comparison is slash-safe either way.
    let prefix = this.apiPrefix;
    if (prefix && !prefix.startsWith('/')) {
      prefix = `/${prefix}`;
    }
    if (prefix && path.startsWith(prefix)) {
      return path.slice(prefix.length) || '/';
    }
    return path;
  }

  private messageFor(status: number): string {
    return DEFAULT_MESSAGES[status] ?? 'Unknown';
  }
}
