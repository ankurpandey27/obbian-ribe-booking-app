import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Producer, ProducerRecord } from 'kafkajs';
import { randomUUID } from 'crypto';
import { DomainEvent, TopicName, TOPICS } from '../../shared/events/topics';
import { KAFKA_PRODUCER } from './kafka.module';

/**
 * EventBus — best-effort publisher for EPHEMERAL signals (matching offers,
 * driver responses, location telemetry).
 *
 * Durable facts do NOT go through here: they go through the transactional
 * outbox so the event commits with the state change it describes
 * (AGENTS.md §3). Losing an EventBus message is acceptable by design; losing
 * an outbox row is not.
 *
 * BROKERLESS MODE (`EVENTS_BROKER_ENABLED=false`, the default) is a supported
 * deployment target. Both `connect()` and `send()` are gated on the flag —
 * previously they ran unconditionally, so a brokerless deploy attempted a
 * Kafka connection at boot and then logged an ERROR for every single offer
 * published during matching. That is noise that masks real failures, and it
 * made the logs useless on exactly the deployment shape the project documents
 * as its free-tier path.
 *
 * Matching remains correct without the broker: offers are stored as Redis keys
 * and the claim is a Redis SET NX, neither of which involves Kafka.
 */
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventBus.name);
  private readonly brokerEnabled: boolean;
  private connected = false;

  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    config: ConfigService,
  ) {
    this.brokerEnabled = config.get<boolean>('events.brokerEnabled', false);
  }

  async onModuleInit() {
    if (!this.brokerEnabled) {
      this.logger.log(
        'brokerless mode — ephemeral events are dropped; matching uses Redis',
      );
      return;
    }
    try {
      await this.producer.connect();
      this.connected = true;
    } catch (err) {
      // Non-fatal: ephemeral events are best-effort, and a broker that is
      // briefly unavailable must never stop the application from starting.
      this.logger.error(`connect failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (!this.brokerEnabled) return;
    await this.producer.disconnect().catch(() => undefined);
  }

  async publish<T>(
    topic: TopicName,
    type: string,
    payload: T,
    partitionKey?: string,
  ): Promise<void> {
    if (!this.brokerEnabled) {
      // Deliberate no-op. Debug level, not error: in brokerless mode this is
      // the expected path, not a failure.
      this.logger.debug(`brokerless: dropped ${type} on ${topic}`);
      return;
    }

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
      // Late connect: covers a broker that came up after boot.
      if (!this.connected) {
        await this.producer.connect();
        this.connected = true;
      }
      await this.producer.send(record);
    } catch (err) {
      // Never let an analytics/signal failure break a ride operation.
      this.connected = false;
      this.logger.error(
        `publish failed topic=${topic} type=${type}: ${(err as Error).message}`,
      );
    }
  }

  /** Convenience for ride lifecycle signals. */
  async publishRide(type: string, payload: unknown, rideId: string) {
    await this.publish(TOPICS.RIDE_EVENTS, type, payload, rideId);
  }
}
