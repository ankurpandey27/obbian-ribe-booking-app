import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const QUEUE_PAYMENTS = 'payments';
export const QUEUE_NOTIFICATIONS = 'notifications';
export const QUEUE_MATCHING = 'matching';
export const QUEUE_SCHEDULED = 'scheduled-rides';

/**
 * BullMQ queues — retryable background work.
 * payments: Razorpay collect, settlement.
 * notifications: FCM/SMS/email dispatch.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        prefix: config.get<string>('queue.prefix', 'ride-booking'),
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
          password: config.get<string>('redis.password') || undefined,
          tls: config.get<boolean>('redis.tls', false) ? {} : undefined,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: QUEUE_PAYMENTS },
      { name: QUEUE_NOTIFICATIONS },
      { name: QUEUE_MATCHING },
      { name: QUEUE_SCHEDULED },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
