import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';

/**
 * OutboxRelayWorker — drains the transactional outbox to the broker.
 * Runs every few seconds; SKIP LOCKED makes concurrent app instances
 * partition work without coordination. Errors are logged, never thrown —
 * the next tick retries whatever stayed PENDING.
 */
@Injectable()
export class OutboxRelayWorker {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private running = false;

  constructor(private readonly outbox: OutboxService) {}

  @Interval(5000)
  async relay(): Promise<void> {
    if (this.running) return; // previous tick still in flight
    this.running = true;
    try {
      let dispatched = await this.outbox.relayOnce();
      // Drain bursts without waiting for the next tick (bounded loop).
      while (dispatched > 0 && dispatched >= 100) {
        dispatched = await this.outbox.relayOnce();
      }
    } catch (err) {
      this.logger.error(`relay failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
