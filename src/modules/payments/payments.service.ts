import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  payments as paymentsTable,
  rides as ridesTable,
} from '../../common/database/schema';
import { ConfigService } from '@nestjs/config';
import Razorpay from 'razorpay';
import { EventBus } from '../../common/events/event-bus.service';
import { WebhookDedupeService } from '../../common/events/webhook-dedupe.service';
import { TOPICS } from '../../shared/events/topics';
import { PaymentEventType } from '../../shared/events/contracts';
import { PaymentMethodValue } from '../../shared/types/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_PAYMENTS } from '../../common/queues/queues.module';
import { MetricsService } from '../../common/observability/metrics.service';

/**
 * PaymentsService — Razorpay UPI collect + webhook + refunds.
 * Amounts in INR; Razorpay expects paise (×100).
 * Driver settlement happens nightly (RazorpayX) — separate job.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly razorpay: Razorpay | null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly events: EventBus,
    private readonly webhookDedupe: WebhookDedupeService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_PAYMENTS) private readonly paymentQueue: Queue,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const keyId = this.config.get<string>('razorpay.keyId');
    const keySecret = this.config.get<string>('razorpay.keySecret');
    this.razorpay =
      keyId && keySecret
        ? new Razorpay({ key_id: keyId, key_secret: keySecret })
        : null;
  }

  /**
   * Queue payment processing (async, retryable). Returns payment id immediately.
   *
   * Guards: amount must match the ride's fare (tamper protection), and the
   * ride must exist. Ownership is enforced by the controller; this layer
   * guarantees the amount is not arbitrary.
   */
  async initiatePayment(
    rideId: string,
    userId: string,
    amount: number,
    method: PaymentMethodValue = 'UPI',
  ) {
    const [existing] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (existing) {
      throw new BadRequestException('Payment already initiated for this ride');
    }

    // Amount must match the ride's quoted/computed fare — never trust a
    // client-supplied amount that diverges from the ride record.
    const [ride] = await this.db
      .select({
        estimatedFare: ridesTable.estimatedFare,
        totalFare: ridesTable.totalFare,
      })
      .from(ridesTable)
      .where(eq(ridesTable.id, rideId))
      .limit(1);
    if (!ride) {
      throw new NotFoundException('Ride not found');
    }
    const expected = Number(ride.totalFare ?? ride.estimatedFare);
    if (!Number.isFinite(amount) || Math.abs(amount - expected) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${amount} does not match ride fare ${expected}`,
      );
    }

    const [payment] = await this.db
      .insert(paymentsTable)
      .values({ rideId, userId, amount, method, status: 'PENDING' })
      .returning();

    await this.paymentQueue.add(
      'create-order',
      { paymentId: payment.id, rideId, amount, method },
      { jobId: `payment-${payment.id}` },
    );

    await this.events.publish(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.PAYMENT_INITIATED,
      {
        paymentId: payment.id,
        rideId,
        amount,
        currency: 'INR',
        method,
      },
      payment.id,
    );

    return payment;
  }

  /** BullMQ worker: create Razorpay order. Retries with backoff on failure. */
  async processOrderJob(data: {
    paymentId: string;
    rideId: string;
    amount: number;
    method: string;
  }) {
    if (!this.razorpay) {
      throw new Error('Razorpay not configured');
    }

    const order = await this.razorpay.orders.create({
      amount: Math.round(data.amount * 100),
      currency: 'INR',
      receipt: data.rideId,
      notes: { rideId: data.rideId },
    });

    await this.db
      .update(paymentsTable)
      .set({
        gatewayOrderId: order.id,
        status: 'PROCESSING',
        updatedAt: new Date(),
      })
      .where(eq(paymentsTable.id, data.paymentId));

    return order;
  }

  /** Verify payment after client-side success (Razorpay SDK signature flow). */
  async verifyPayment(
    rideId: string,
    razorpayOrderId: string,
    razorpayPaymentId: string,
    signature: string,
  ) {
    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment || payment.gatewayOrderId !== razorpayOrderId) {
      throw new NotFoundException('Payment record not found');
    }

    if (!this.razorpay) {
      throw new BadRequestException('Razorpay not configured');
    }

    // HMAC-SHA256 verification (the security-critical step)
    const { validateWebhookSignature } =
      await import('razorpay/dist/utils/razorpay-utils');
    const expected = validateWebhookSignature(
      `${razorpayOrderId}|${razorpayPaymentId}`,
      signature,
      this.config.get<string>('razorpay.keySecret') ?? '',
    );
    if (!expected) {
      throw new BadRequestException('Invalid payment signature');
    }

    // Amount on the payment record must match the ride fare — a tampered or
    // misrouted payment row must never be marked COMPLETED.
    const [ride] = await this.db
      .select({
        estimatedFare: ridesTable.estimatedFare,
        totalFare: ridesTable.totalFare,
      })
      .from(ridesTable)
      .where(eq(ridesTable.id, rideId))
      .limit(1);
    const expectedAmount = ride
      ? Number(ride.totalFare ?? ride.estimatedFare)
      : null;
    if (
      expectedAmount !== null &&
      Math.abs(Number(payment.amount) - expectedAmount) > 0.01
    ) {
      throw new BadRequestException(
        `Payment amount ${payment.amount} does not match ride fare ${expectedAmount}`,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(paymentsTable)
        .set({
          status: 'COMPLETED',
          gatewayPaymentId: razorpayPaymentId,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(paymentsTable.id, payment.id));
      await tx
        .update(ridesTable)
        .set({ paymentStatus: 'COMPLETED' })
        .where(eq(ridesTable.id, rideId));
    });

    await this.events.publish(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.PAYMENT_SUCCEEDED,
      {
        paymentId: payment.id,
        rideId,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
        gatewayTransactionId: razorpayPaymentId,
      },
      payment.id,
    );

    return { success: true, transactionId: razorpayPaymentId };
  }

  /**
   * Server-to-server webhook from Razorpay.
   *
   * EXACTLY-ONCE, not at-least-once. Razorpay retries on any ambiguous response
   * — a timeout, a 5xx, even a slow ACK — and explicitly does not promise
   * once-only delivery. Without dedupe a retried `payment.captured` re-applied
   * the capture, and once settlement reads those rows the driver can be credited
   * for the same ride twice. That is unrecoverable money, so the guard is a
   * UNIQUE (source, eventId) claim rather than a status check.
   *
   * The claim is taken INSIDE the same transaction as the state change. If it
   * committed separately and the handler then failed, the event would be marked
   * processed forever while having had no effect — a silently dropped payment.
   * Sharing the transaction means a rollback releases the claim and the next
   * retry is free to try again.
   */
  async handleWebhook(body: unknown, signature?: string, rawBody?: Buffer) {
    const secret = this.config.get<string>('razorpay.webhookSecret');
    // Fail closed: a webhook without a configured secret is rejected outright.
    // An insecure deployment must not silently accept unsigned webhooks.
    if (!secret) {
      throw new BadRequestException(
        'Webhook signature verification not configured',
      );
    }
    // Verify the HMAC over the RAW wire bytes — Razorpay signs the raw body,
    // not a re-serialization of the parsed JSON.
    const raw = rawBody ? rawBody.toString('utf8') : JSON.stringify(body);
    const { validateWebhookSignature } =
      await import('razorpay/dist/utils/razorpay-utils');
    const valid = validateWebhookSignature(raw, signature ?? '', secret);
    if (!valid) throw new BadRequestException('Invalid webhook signature');

    const payload = body as {
      /** Razorpay's own delivery id — the dedupe key. */
      id?: string;
      event?: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            error_description?: string;
            notes?: { ride_id?: string };
          };
        };
      };
    };
    const entity = payload?.payload?.payment?.entity;
    const rideId = entity?.notes?.ride_id;
    const event = payload.event;

    /**
     * Dedupe key. Razorpay's top-level `id` identifies the DELIVERY; the payment
     * entity id identifies the payment. Prefer the delivery id, and fall back to
     * `event:paymentId` so a provider that omits the top-level id still dedupes
     * per (event type, payment) rather than not at all.
     */
    const eventId =
      payload.id ?? (entity?.id && event ? `${event}:${entity.id}` : '');

    if (!rideId) {
      this.metrics?.recordWebhook('razorpay', event ?? 'unknown', 'ignored');
      return { received: true };
    }

    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment) {
      this.metrics?.recordWebhook('razorpay', event ?? 'unknown', 'ignored');
      return { received: true };
    }

    if (event === 'payment.captured' || event === 'payment.authorized') {
      const applied = await this.db.transaction(async (tx) => {
        const claim = await this.webhookDedupe.claim(
          {
            source: 'RAZORPAY',
            eventId,
            eventType: event,
            referenceType: 'payment',
            referenceId: payment.id,
            rawBody: rawBody ? rawBody.toString('utf8') : undefined,
          },
          tx,
        );
        // Already handled by an earlier delivery — ack without re-applying.
        if (!claim.isFirstDelivery) return false;

        await tx
          .update(paymentsTable)
          .set({
            status: 'COMPLETED',
            paidAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(paymentsTable.id, payment.id));
        await tx
          .update(ridesTable)
          .set({ paymentStatus: 'COMPLETED' })
          .where(eq(ridesTable.id, rideId));
        return true;
      });

      this.metrics?.recordWebhook(
        'razorpay',
        event,
        applied ? 'applied' : 'duplicate',
      );
      if (applied)
        this.metrics?.recordPaymentOutcome(payment.method, 'completed');
      return { received: true, applied, duplicate: !applied };
    }

    if (event === 'payment.failed') {
      const applied = await this.db.transaction(async (tx) => {
        const claim = await this.webhookDedupe.claim(
          {
            source: 'RAZORPAY',
            eventId,
            eventType: event,
            referenceType: 'payment',
            referenceId: payment.id,
            rawBody: rawBody ? rawBody.toString('utf8') : undefined,
          },
          tx,
        );
        if (!claim.isFirstDelivery) return false;

        await tx
          .update(paymentsTable)
          .set({
            status: 'FAILED',
            failureReason: entity?.error_description,
            updatedAt: new Date(),
          })
          .where(eq(paymentsTable.id, payment.id));
        return true;
      });

      if (!applied) {
        this.metrics?.recordWebhook('razorpay', event, 'duplicate');
        return { received: true, applied: false, duplicate: true };
      }

      await this.events.publish(
        TOPICS.PAYMENT_EVENTS,
        PaymentEventType.PAYMENT_FAILED,
        {
          paymentId: payment.id,
          rideId,
          amount: Number(payment.amount),
          currency: payment.currency,
          method: payment.method,
          failureReason: entity?.error_description ?? 'payment failed',
        },
        payment.id,
      );
      this.metrics?.recordWebhook('razorpay', event, 'applied');
      this.metrics?.recordPaymentOutcome(payment.method, 'failed');
      return { received: true, applied: true, duplicate: false };
    }

    // Unhandled event type — ack so Razorpay stops retrying it.
    this.metrics?.recordWebhook('razorpay', event ?? 'unknown', 'ignored');
    return { received: true, applied: false, duplicate: false };
  }

  async getPayment(rideId: string) {
    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * Refund a completed payment. Idempotent + race-safe: a conditional update
   * claims the payment (COMPLETED -> REFUNDING) so exactly one caller can
   * drive the gateway refund. A concurrent second call sees the already-claimed
   * row and returns the existing outcome instead of double-refunding.
   *
   * The Razorpay refund call uses a deterministic reference (the payment id)
   * so even a gateway retry is deduplicated upstream.
   */
  async refund(
    rideId: string,
  ): Promise<{ refunded: boolean; amount: number; alreadyRefunded?: boolean }> {
    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    if (payment.status === 'REFUNDED' || payment.status === 'REFUNDING') {
      // Already refunded or in flight — idempotent success, no gateway call.
      return { refunded: true, amount: 0, alreadyRefunded: true };
    }
    if (payment.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed payments can be refunded');
    }

    if (!this.razorpay)
      throw new BadRequestException('Razorpay not configured');

    // ATOMIC CLAIM: only the first caller moves COMPLETED -> REFUNDING.
    // Concurrent refunds get 0 rows here and fall through to the idempotency
    // check above on retry.
    const [claimed] = await this.db
      .update(paymentsTable)
      .set({ status: 'REFUNDING', updatedAt: new Date() })
      .where(
        and(
          eq(paymentsTable.id, payment.id),
          eq(paymentsTable.status, 'COMPLETED'),
        ),
      )
      .returning({ id: paymentsTable.id });

    if (!claimed) {
      // Lost the race — someone else claimed it between select and update.
      return { refunded: true, amount: 0, alreadyRefunded: true };
    }

    // Deterministic idempotency reference for the gateway.
    const idempotencyRef = `refund-${payment.id}`;
    let refund: { id: string };
    try {
      refund = await this.razorpay.payments.refund(payment.gatewayPaymentId, {
        speed: 'normal',
        receipt: idempotencyRef,
      });
    } catch (err) {
      // Gateway failed — release the claim so a retry can attempt again.
      await this.db
        .update(paymentsTable)
        .set({ status: 'COMPLETED', updatedAt: new Date() })
        .where(eq(paymentsTable.id, payment.id));
      throw err;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(paymentsTable)
        .set({
          status: 'REFUNDED',
          refundedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(paymentsTable.id, payment.id));
      await tx
        .update(ridesTable)
        .set({ paymentStatus: 'REFUNDED' })
        .where(eq(ridesTable.id, rideId));
    });

    await this.events.publish(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.PAYMENT_REFUNDED,
      {
        paymentId: payment.id,
        rideId,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
        gatewayTransactionId: refund.id,
      },
      payment.id,
    );

    // Return the actual disbursed amount — single source of truth so callers
    // (ride cancel) report the money that actually moved, not a recomputed
    // estimate that can diverge from the gateway refund.
    return { refunded: true, amount: Number(payment.amount) };
  }
}
