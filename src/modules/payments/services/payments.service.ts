import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../../common/database/drizzle.module';
import {
  payments as paymentsTable,
  rides as ridesTable,
} from '../../../common/database/schema';
import { ConfigService } from '@nestjs/config';
import Razorpay from 'razorpay';
import { EventBus } from '../../../common/events/event-bus.service';
import { TOPICS } from '../../../shared/events/topics';
import { PaymentEventType } from '../../../shared/events/contracts';
import { PaymentMethodValue } from '../../../shared/types/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_PAYMENTS } from '../../../common/queues/queues.module';

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
    private readonly config: ConfigService,
    @InjectQueue(QUEUE_PAYMENTS) private readonly paymentQueue: Queue,
  ) {
    const keyId = this.config.get<string>('razorpay.keyId');
    const keySecret = this.config.get<string>('razorpay.keySecret');
    this.razorpay =
      keyId && keySecret
        ? new Razorpay({ key_id: keyId, key_secret: keySecret })
        : null;
  }

  /** Queue payment processing (async, retryable). Returns payment id immediately. */
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

  /** Server-to-server webhook (auth via webhook secret header). */
  async handleWebhook(body: unknown, signature?: string) {
    const secret = this.config.get<string>('razorpay.webhookSecret');
    if (secret) {
      const { validateWebhookSignature } =
        await import('razorpay/dist/utils/razorpay-utils');
      const valid = validateWebhookSignature(
        JSON.stringify(body),
        signature ?? '',
        secret,
      );
      if (!valid) throw new BadRequestException('Invalid webhook signature');
    }

    const payload = body as {
      event?: string;
      payload?: {
        payment?: { entity?: { id?: string; notes?: { ride_id?: string } } };
      };
    };
    const entity = payload?.payload?.payment?.entity;
    const rideId = entity?.notes?.ride_id;
    if (!rideId) return { received: true };

    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment) return { received: true };

    const event = payload.event;
    if (event === 'payment.captured' || event === 'payment.authorized') {
      await this.db.transaction(async (tx) => {
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
      });
    } else if (event === 'payment.failed') {
      await this.db
        .update(paymentsTable)
        .set({
          status: 'FAILED',
          failureReason: (entity as Record<string, unknown>)
            ?.error_description as string,
          updatedAt: new Date(),
        })
        .where(eq(paymentsTable.id, payment.id));
      await this.events.publish(
        TOPICS.PAYMENT_EVENTS,
        PaymentEventType.PAYMENT_FAILED,
        {
          paymentId: payment.id,
          rideId,
          amount: Number(payment.amount),
          currency: payment.currency,
          method: payment.method,
          failureReason: 'payment failed',
        },
        payment.id,
      );
    }

    return { received: true };
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

  async refund(rideId: string) {
    const [payment] = await this.db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.rideId, rideId))
      .limit(1);
    if (!payment || payment.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed payments can be refunded');
    }

    if (!this.razorpay)
      throw new BadRequestException('Razorpay not configured');

    const refund = await this.razorpay.payments.refund(
      payment.gatewayPaymentId,
      {},
    );
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

    return { refunded: true };
  }
}
