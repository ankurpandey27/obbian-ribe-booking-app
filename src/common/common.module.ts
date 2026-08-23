import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBus } from './events/event-bus.service';
import { OutboxService } from './events/outbox.service';
import { OutboxRelayWorker } from './events/outbox-relay.worker';
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
  providers: [EventBus, OutboxService, OutboxRelayWorker],
  exports: [EventBus, OutboxService],
})
export class CommonModule {}
