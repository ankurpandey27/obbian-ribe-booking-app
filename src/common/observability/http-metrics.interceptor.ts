import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { RequestContext } from './request-context';

/**
 * Label for requests Express matched no route layer. NEVER use the raw URL:
 * an attacker (or a broken client) hitting random paths would mint a new time
 * series per path and exhaust the metrics store.
 */
const UNMATCHED_ROUTE = 'unmatched';

const MAX_ROUTE_LABEL_CHARS = 120;

/**
 * Request rate, latency, in-flight depth, plus a slow-request warning
 * correlated by requestId. Registered as APP_INTERCEPTOR (not
 * `useGlobalInterceptors`) because it needs MetricsService/ConfigService
 * injected — instances built by hand cannot participate in DI.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpMetrics');
  private readonly slowRequestMs: number;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.slowRequestMs = config.get<number>(
      'observability.slowRequestMs',
      1000,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Websocket and scheduled contexts have no HTTP semantics to record.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    this.metrics.incHttpInFlight();

    let settled = false;
    const finish = (thrown?: unknown): void => {
      // `tap` can fire next+complete for the same request; count once.
      if (settled) return;
      settled = true;
      this.metrics.decHttpInFlight();

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = this.routeLabel(request);
      const status = this.statusOf(response, thrown);

      this.metrics.observeHttpRequest(
        request.method,
        route,
        status,
        durationMs / 1000,
      );

      if (durationMs >= this.slowRequestMs) {
        // Warn, not error: paging on every slow request during a dependency
        // blip is noise.
        this.logger.warn(
          `slow request ${request.method} ${route} status=${status} ${durationMs.toFixed(1)}ms`,
        );
      }
    };

    // Counted in tap's next/error/complete positions so a request is recorded
    // exactly once whether it succeeded, threw, or the client disconnected —
    // otherwise error responses vanish from the metric and the error-rate
    // panel reads 0% during an outage.
    return next.handle().pipe(
      tap({
        next: () => undefined,
        error: (err) => finish(err),
        complete: () => finish(),
      }),
    );
  }

  /** Route TEMPLATE for the label, e.g. `/api/v1/rides/:id`. */
  private routeLabel(request: Request): string {
    const layer = (request as Request & { route?: { path?: string } }).route;
    const path = layer?.path;
    if (!path) return UNMATCHED_ROUTE;

    const base = request.baseUrl ?? '';
    const template = `${base}${path}` || UNMATCHED_ROUTE;
    const label =
      template.length > MAX_ROUTE_LABEL_CHARS
        ? template.slice(0, MAX_ROUTE_LABEL_CHARS)
        : template;

    // Cached so the slow-request log and downstream consumers agree on the
    // same label.
    RequestContext.set({ route: label });
    return label;
  }

  /**
   * On a thrown exception the response has not been written yet, so
   * `response.statusCode` still holds the handler's intended status (200).
   * Reading the exception's own status is what keeps 4xx/5xx out of the 200
   * bucket.
   */
  private statusOf(response: Response, thrown?: unknown): number {
    if (!thrown) return response.statusCode;

    const status = (thrown as { status?: unknown; statusCode?: unknown })
      .status;
    const statusCode = (thrown as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
    if (typeof statusCode === 'number') return statusCode;
    return 500;
  }
}
