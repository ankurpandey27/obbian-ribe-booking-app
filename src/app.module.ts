import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { configFactory } from './config/configuration';
import { DatabaseModule } from './common/database/database.module';
import { DrizzleModule } from './common/database/drizzle.module';
import { RedisModule, REDIS_CLIENT } from './common/redis/redis.module';
import { RedisThrottlerStorage } from './common/redis/redis-throttler.storage';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { KafkaModule } from './common/events/kafka.module';
import { QueuesModule } from './common/queues/queues.module';
import { CommonModule } from './common/common.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthModule } from './modules/health/health.module';
import { MapsModule } from './modules/maps/maps.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RidesModule } from './modules/rides/rides.module';
import { MatchingModule } from './modules/matching/matching.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { PromosModule } from './modules/promos/promos.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AgentModule } from './modules/agent/agent.module';
import { SafetyModule } from './modules/safety/safety.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { OpsModule } from './modules/ops/ops.module';
import { GrowthModule } from './modules/growth/growth.module';
import { AdminModule } from './modules/admin/admin.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ConfigService } from '@nestjs/config';

/**
 * Composition root — imports modules only. No business logic here.
 * Global infra: config, DB, Redis, Kafka, queues.
 * Global guards: JWT auth (opt-out via @Public), roles, throttling.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: configFactory, cache: true }),
    ScheduleModule.forRoot(),

    // Global infrastructure
    ObservabilityModule,
    DatabaseModule,
    DrizzleModule,
    RedisModule,
    KafkaModule,
    QueuesModule,
    CommonModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      imports: [RedisModule],
      useFactory: (config: ConfigService, redis: unknown) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttle.ttl', 60000),
            limit: config.get<number>('throttle.limit', 100),
          },
        ],
        storage: new RedisThrottlerStorage(redis as never),
      }),
    }),

    // Domain modules (each a future microservice)
    AuthModule,
    UsersModule,
    DriversModule,
    HealthModule,
    MapsModule,
    PricingModule,
    RidesModule,
    MatchingModule,
    TrackingModule,
    PaymentsModule,
    RatingsModule,
    PromosModule,
    NotificationsModule,
    AnalyticsModule,
    AgentModule,
    SafetyModule,
    ComplianceModule,
    LedgerModule,
    OpsModule,
    GrowthModule,
    AdminModule,
    CatalogModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
