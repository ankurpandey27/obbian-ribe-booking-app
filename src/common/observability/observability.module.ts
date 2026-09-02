import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsServer } from './metrics.server';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { DbMetricsBinder } from './db-metrics.binder';

/**
 * ObservabilityModule — metrics registry, scrape listener, HTTP and database
 * instrumentation.
 *
 * Global because domain services inject {@link MetricsService} optionally from
 * anywhere; making every module import this would add a line of wiring per
 * module for a cross-cutting concern with no domain meaning.
 *
 * Nothing in `common/` holds business logic (AGENTS §5), and this module keeps
 * that property: it records what happened, it never decides anything.
 */
@Global()
@Module({
  providers: [
    MetricsService,
    MetricsServer,
    DbMetricsBinder,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
