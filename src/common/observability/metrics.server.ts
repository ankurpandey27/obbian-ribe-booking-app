import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { MetricsService } from './metrics.service';

/**
 * Idle sockets are closed aggressively. Prometheus reuses a connection between
 * scrapes, but a stale keep-alive socket held past shutdown delays pod
 * termination for no benefit.
 */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** Ceiling on how long a scrape may take before the socket is abandoned. */
const SCRAPE_TIMEOUT_MS = 10_000;

/**
 * Serves the Prometheus scrape endpoint on its own port.
 *
 * WHY A SEPARATE LISTENER INSTEAD OF A ROUTE ON THE API:
 *  1. The endpoint is unauthenticated by design (Prometheus has no credential
 *     story worth adopting for in-cluster scraping), so it must not be
 *     reachable through the public ingress — a path-based rule is one
 *     misconfiguration away from exposing internal state that is useful
 *     reconnaissance (queue depths, error counts, route inventory).
 *  2. It stays answerable when the API is saturated: sharing the express app
 *     and its middleware chain would blind monitoring at the exact moment it
 *     is needed.
 *
 * DEPLOYMENT REQUIREMENT: publish only the API port on the load balancer, and
 * restrict METRICS_PORT to the cluster/monitoring network.
 */
@Injectable()
export class MetricsServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MetricsServer.name);
  private readonly port: number;
  private readonly path: string;
  private server?: Server;

  constructor(
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.port = config.get<number>('observability.metricsPort', 9464);
    const configured = config.get<string>(
      'observability.metricsPath',
      '/metrics',
    );
    this.path = configured.startsWith('/') ? configured : `/${configured}`;
  }

  onApplicationBootstrap(): void {
    if (!this.metrics.enabled) {
      this.logger.warn(
        'METRICS_ENABLED=false — no scrape endpoint. The service is running blind to Prometheus.',
      );
      return;
    }

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.requestTimeout = SCRAPE_TIMEOUT_MS;

    // A metrics port collision (a second local instance, a sidecar already on
    // 9464) must not take the API down with it. Losing telemetry is a
    // degradation; failing to boot is an outage.
    server.on('error', (err) => {
      this.logger.error(
        `metrics listener failed on port ${this.port}: ${err.message} — continuing without a scrape endpoint`,
      );
    });

    server.listen(this.port, () => {
      this.logger.log(
        `metrics exposed on :${this.port}${this.path} (private port — do not route through public ingress)`,
      );
    });

    this.server = server;
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      // closeAllConnections so a keep-alive scrape socket cannot hold the
      // process open past the termination grace period.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Only ever GET, only ever the configured path. Everything else is refused
    // without touching the registry, so this listener cannot be repurposed.
    const requestPath = (req.url ?? '/').split('?')[0];

    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain' });
      res.end('method not allowed\n');
      return;
    }
    if (requestPath !== this.path) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }

    try {
      const body = await this.metrics.render();
      res.writeHead(200, { 'content-type': this.metrics.contentType });
      res.end(body);
    } catch (err) {
      this.logger.error(`scrape render failed: ${(err as Error).message}`);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('metrics unavailable\n');
    }
  }
}
