import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';

export const KAFKA_CLIENT = 'KAFKA_CLIENT';
export const KAFKA_PRODUCER = 'KAFKA_PRODUCER';

/**
 * Kafka infrastructure.
 *
 * BROKERLESS MODE is a first-class deployment target (`EVENTS_BROKER_ENABLED=false`,
 * the default): the outbox still records every durable fact and the relay
 * drains rows locally. The producer only CONNECTS when the broker is enabled —
 * an unconditional connect made brokerless deploys pay ~30s of retries against
 * a broker that would never be used, enough to exhaust a Kubernetes startup
 * probe and get the pod killed in a loop. OutboxService guards every `.send()`
 * behind the same flag, so an unconnected producer is never touched.
 */
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
      inject: [KAFKA_CLIENT, ConfigService],
      useFactory: async (kafka: Kafka, config: ConfigService) => {
        const producer: Producer = kafka.producer();
        const logger = new Logger('KafkaModule');

        // `events.brokerEnabled` is parsed to a boolean by the config factory.
        const brokerEnabled = config.get<boolean>(
          'events.brokerEnabled',
          false,
        );
        if (!brokerEnabled) {
          logger.log(
            'brokerless mode (EVENTS_BROKER_ENABLED=false) — skipping producer ' +
              'connect; outbox rows drain locally',
          );
          return producer;
        }

        // Connect failures are non-fatal: the outbox retains every event and
        // the relay retries, so a briefly-down broker must not stop boot.
        await producer.connect().catch((err: Error) => {
          logger.error(
            `producer connect failed (outbox will retry on demand): ${err.message}`,
          );
        });
        return producer;
      },
    },
  ],
  exports: [KAFKA_CLIENT, KAFKA_PRODUCER],
})
export class KafkaModule {}
