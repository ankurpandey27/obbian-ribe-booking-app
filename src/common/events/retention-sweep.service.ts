import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { OutboxDlqService } from './outbox-dlq.service';
import { WebhookDedupeService } from './webhook-dedupe.service';

export interface RetentionReport {
  processedWebhooksPurged: number;
  publishedOutboxPurged: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * RetentionSweepService — keeps the append-only operational tables bounded.
 *
 * Two tables here exist to make other things correct, not to be kept forever:
 *
 *  - `processed_webhooks` only needs to outlive the provider's retry horizon.
 *    Razorpay gives up well inside a day; 30 days is generous. Keeping it
 *    unbounded turns an operational guard into the largest table in the schema.
 *  - `outbox_events` doubles as a replay/audit log, so PUBLISHED rows are kept
 *    for a window and then dropped.
 *
 * FAILED outbox rows are deliberately NEVER purged. Each one is a durable fact
 * that never reached its consumers — unresolved data loss. Ageing those out
 * would quietly delete the evidence instead of fixing the problem, so they stay
 * until an operator retries or explicitly discards them.
 */
@Injectable()
export class RetentionSweepService {
  private readonly logger = new Logger(RetentionSweepService.name);
  private readonly enabled: boolean;
  private readonly processedWebhookDays: number;
  private readonly publishedOutboxDays: number;

  constructor(
    private readonly dlq: OutboxDlqService,
    private readonly webhookDedupe: WebhookDedupeService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('retention.enabled', true);
    this.processedWebhookDays = config.get<number>(
      'retention.processedWebhookDays',
      30,
    );
    this.publishedOutboxDays = config.get<number>(
      'retention.publishedOutboxDays',
      30,
    );
  }

  @Cron('45 2 * * *')
  async sweepNightly(): Promise<RetentionReport> {
    if (!this.enabled) {
      this.logger.log('retention sweep disabled, skipping run');
      return this.emptyReport();
    }
    return this.runSweep();
  }

  async runSweep(now = new Date()): Promise<RetentionReport> {
    const startedAt = new Date().toISOString();

    // Independent deletes — run them concurrently rather than in sequence.
    const [processedWebhooksPurged, publishedOutboxPurged] = await Promise.all([
      this.webhookDedupe
        .purgeOlderThan(this.daysAgo(now, this.processedWebhookDays))
        .catch((err) => {
          // One table failing must not stop the other from being trimmed.
          this.logger.error(
            `processed_webhooks purge failed: ${(err as Error).message}`,
          );
          return 0;
        }),
      this.dlq
        .purgePublishedOlderThan(this.daysAgo(now, this.publishedOutboxDays))
        .catch((err) => {
          this.logger.error(`outbox purge failed: ${(err as Error).message}`);
          return 0;
        }),
    ]);

    // Surface the DLQ depth on every sweep. This is the one place a stuck event
    // reliably becomes visible without someone opening a dashboard.
    const summary = await this.dlq.summary().catch(() => null);
    if (summary && summary.failedCount > 0) {
      this.logger.error(
        `OUTBOX DLQ NOT EMPTY: ${summary.failedCount} event(s) never reached ` +
          `their consumers, oldest ${summary.oldestFailedAt?.toISOString()}. ` +
          `By type: ${summary.byType
            .map((t) => `${t.type}=${t.count}`)
            .join(', ')}`,
      );
    }

    this.logger.log(
      `retention sweep complete: ${processedWebhooksPurged} webhook record(s), ` +
        `${publishedOutboxPurged} published outbox row(s)`,
    );

    return {
      processedWebhooksPurged,
      publishedOutboxPurged,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  private daysAgo(from: Date, days: number): Date {
    const cutoff = new Date(from);
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }

  private emptyReport(): RetentionReport {
    const now = new Date().toISOString();
    return {
      processedWebhooksPurged: 0,
      publishedOutboxPurged: 0,
      startedAt: now,
      finishedAt: now,
    };
  }
}
