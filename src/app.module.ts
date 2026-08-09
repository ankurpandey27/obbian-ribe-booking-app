import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { configFactory } from './config/configuration';
import { DatabaseModule } from './common/database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { KafkaModule } from './common/events/kafka.module';
import { QueuesModule } from './common/queues/queues.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { DriversModule } from './modules/drivers/drivers.module';
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
    DatabaseModule,
    RedisModule,
    KafkaModule,
    QueuesModule,
    CommonModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('throttle.ttl', 60000),
          limit: config.get<number>('throttle.limit', 100),
        },
      ],
    }),

    // Domain modules (each a future microservice)
    AuthModule,
    UsersModule,
    DriversModule,
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
