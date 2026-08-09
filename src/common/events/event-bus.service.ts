import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Producer, ProducerRecord } from 'kafkajs';
import { randomUUID } from 'crypto';
import { DomainEvent, TopicName, TOPICS } from '../../shared/events/topics';
import { KAFKA_PRODUCER } from './kafka.module';

/**
 * EventBus — the only way modules publish domain events.
 * Produces to Kafka topics defined in shared/events/topics.ts.
 * In a monolith this is in-process Kafka; after split it becomes
 * a remote producer — callers never know the difference.
 */
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(KAFKA_PRODUCER) private readonly producer: Producer) {}

  async onModuleInit() {
    try {
      await this.producer.connect();
    } catch (err) {
      console.error('[eventbus] connect failed', (err as Error).message);
    }
  }

  async onModuleDestroy() {
    await this.producer.disconnect().catch(() => undefined);
  }

  async publish<T>(
    topic: TopicName,
    type: string,
    payload: T,
    partitionKey?: string,
  ): Promise<void> {
    const event: DomainEvent<T> = {
      id: randomUUID(),
      topic,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };

    const record: ProducerRecord = {
      topic,
      messages: [{ key: partitionKey, value: JSON.stringify(event) }],
    };

    try {
      await this.producer.send(record);
    } catch (err) {
      // Never let analytics/event failure break a ride operation.
      console.error(
        `[eventbus] publish failed topic=${topic} type=${type}`,
        (err as Error).message,
      );
    }
  }

  /** Convenience for ride lifecycle events. */
  async publishRide(type: string, payload: unknown, rideId: string) {
    await this.publish(TOPICS.RIDE_EVENTS, type, payload, rideId);
  }
}
