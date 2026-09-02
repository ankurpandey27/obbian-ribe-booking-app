import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBus } from './events/event-bus.service';
import { OutboxService } from './events/outbox.service';
import { OutboxRelayWorker } from './events/outbox-relay.worker';
import { OutboxDlqService } from './events/outbox-dlq.service';
import { WebhookDedupeService } from './events/webhook-dedupe.service';
import { RetentionSweepService } from './events/retention-sweep.service';
import { OutboxEvent } from './events/outbox.entity';

/**
 * Global shared services — event infrastructure is used by every domain
 * module; provide it once here instead of importing it everywhere.
 *
 * Event delivery contract:
 *  - Durable facts (ride lifecycle) → transactional outbox → relay → broker.
 *  - Ephemeral matching signals → EventBus.publish (best-effort, in-flight).
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent])],
  providers: [
    EventBus,
    OutboxService,
    OutboxRelayWorker,
    OutboxDlqService,
    WebhookDedupeService,
    RetentionSweepService,
  ],
  exports: [EventBus, OutboxService, OutboxDlqService, WebhookDedupeService],
})
export class CommonModule {}
