import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../database/drizzle.module';
import { processedWebhooks } from '../database/schema';

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];
type Exec = DrizzleDB | Tx;

const PG_UNIQUE_VIOLATION = '23505';

export interface WebhookClaim {
  /** false when this event id has already been handled. */
  isFirstDelivery: boolean;
  source: string;
  eventId: string;
}

export interface ClaimWebhookInput {
  /** 'RAZORPAY' | 'ROJU_AGENT' | … */
  source: string;
  /** The PROVIDER's event id — the dedupe key. Never one we generate. */
  eventId: string;
  eventType?: string;
  referenceType?: string;
  referenceId?: string;
  /** Raw body, hashed for support lookups. Never stored verbatim. */
  rawBody?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Makes inbound webhook handling exactly-once.
 *
 * WHY: providers retry — Razorpay re-sends `payment.captured` on any ambiguous
 * response, and without dedupe the same capture was applied twice, which once
 * settlement reads those rows is double credit for one ride: unrecoverable money.
 *
 * MECHANISM — INSERT FIRST, then act. The claim is an INSERT against
 * UNIQUE (source, eventId); a unique violation means "already handled". This is
 * deliberately not SELECT-then-INSERT: two concurrent retries would both see
 * "not present" and both proceed — only the constraint can arbitrate.
 *
 * TRANSACTION PLACEMENT MATTERS: pass the caller's transaction so the claim
 * commits with the state change it guards. A separately-committed claim plus a
 * handler failure would leave the event permanently marked processed with no
 * effect — a silently dropped payment. Sharing the transaction rolls the claim
 * back on failure and the provider's retry is free to try again.
 */
@Injectable()
export class WebhookDedupeService {
  private readonly logger = new Logger(WebhookDedupeService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  /**
   * Returns `isFirstDelivery: false` when the event was already processed. The
   * caller MUST treat that as success and return 2xx — answering with an error
   * makes the provider retry forever.
   */
  async claim(input: ClaimWebhookInput, tx?: Exec): Promise<WebhookClaim> {
    const exec = tx ?? this.db;
    const eventId = input.eventId?.trim();

    if (!eventId) {
      // Cannot dedupe without a provider event id. Process rather than drop a
      // real payment, but say so loudly — it points at an unmapped payload shape.
      this.logger.warn(
        `webhook from ${input.source} has no event id — processing WITHOUT ` +
          'dedupe protection',
      );
      return { isFirstDelivery: true, source: input.source, eventId: '' };
    }

    try {
      await exec.insert(processedWebhooks).values({
        source: input.source,
        eventId,
        eventType: input.eventType,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        payloadDigest: input.rawBody ? this.digest(input.rawBody) : undefined,
        metadata: input.metadata,
      });
      return { isFirstDelivery: true, source: input.source, eventId };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.log(
          `duplicate webhook ${input.source}/${eventId} — already processed, ` +
            'acknowledging without re-applying',
        );
        return { isFirstDelivery: false, source: input.source, eventId };
      }
      throw err;
    }
  }

  /** Read-only check; not a claim. */
  async wasProcessed(source: string, eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: processedWebhooks.id })
      .from(processedWebhooks)
      .where(
        and(
          eq(processedWebhooks.source, source),
          eq(processedWebhooks.eventId, eventId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * The table only needs to outlive the provider's retry horizon (Razorpay
   * gives up well inside a day); keeping it forever turns an operational
   * guard into an unbounded table.
   */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(processedWebhooks)
      .where(lt(processedWebhooks.processedAt, cutoff))
      .returning({ id: processedWebhooks.id });
    if (deleted.length > 0) {
      this.logger.log(`purged ${deleted.length} processed-webhook record(s)`);
    }
    return deleted.length;
  }

  /**
   * SHA-256 digest, truncated to the column width — not the payload itself:
   * webhook bodies carry payment identifiers and contact details, and the
   * digest still proves two deliveries were byte-identical.
   */
  private digest(rawBody: string): string {
    return createHash('sha256').update(rawBody).digest('hex').slice(0, 64);
  }

  /** Drizzle wraps pg errors — the code lives on `.cause`. */
  private isUniqueViolation(err: unknown): boolean {
    let current: unknown = err;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if ((current as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}
