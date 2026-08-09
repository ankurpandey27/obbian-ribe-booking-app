import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';

export const KAFKA_CLIENT = 'KAFKA_CLIENT';
export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Kafka({
          clientId: config.get<string>('kafka.clientId', 'ride-booking'),
          brokers: config.get<string[]>('kafka.brokers', ['localhost:9092']),
          retry: { initialRetryTime: 100, retries: 8, maxRetryTime: 30000 },
        }),
    },
    {
      provide: KAFKA_PRODUCER,
      inject: [KAFKA_CLIENT],
      useFactory: async (kafka: Kafka) => {
        const producer: Producer = kafka.producer();
        await producer.connect().catch((err) => {
          console.error(
            '[kafka] producer connect failed (will retry on demand)',
            err.message,
          );
        });
        return producer;
      },
    },
  ],
  exports: [KAFKA_CLIENT, KAFKA_PRODUCER],
})
export class KafkaModule {}
