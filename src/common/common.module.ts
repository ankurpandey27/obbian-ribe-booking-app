import { Global, Module } from '@nestjs/common';
import { EventBus } from './events/event-bus.service';

/**
 * Global shared services — EventBus (Kafka fan-out) is used by every
 * domain module; provide it once here instead of importing it everywhere.
 */
@Global()
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class CommonModule {}
