import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { adminAuditLog, users } from '../../common/database/schema';
import { OutboxDlqService } from '../../common/events/outbox-dlq.service';
import { DriverDocumentsService } from '../compliance/driver-documents.service';
import { PaymentsService } from '../payments/payments.service';
import { InvoiceService } from '../pricing/invoice.service';
import { WalletLedgerService } from '../payments/wallet-ledger.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly dlq: OutboxDlqService,
    private readonly documents: DriverDocumentsService,
    private readonly payments: PaymentsService,
    private readonly invoices: InvoiceService,
    private readonly ledger: WalletLedgerService,
  ) {}

  dlqSummary() {
    return this.dlq.summary();
  }

  listDlq(limit = 50, offset = 0) {
    return this.dlq.list(limit, offset);
  }

  async retryDlq(ids: string[], actorUserId: string) {
    const result = await this.dlq.retry(ids, actorUserId);
    await this.audit(actorUserId, 'DLQ_RETRY', 'outbox', result.ids.join(','), {
      count: result.requeued,
    });
    return result;
  }

  async retryDlqType(type: string, actorUserId: string) {
    const result = await this.dlq.retryByType(type, actorUserId);
    await this.audit(actorUserId, 'DLQ_RETRY_TYPE', 'outbox', type, {
      count: result.requeued,
    });
    return result;
  }

  listComplianceQueue(limit?: number, offset?: number) {
    return this.documents.listReviewQueue(limit, offset);
  }

  async refund(rideId: string, actorUserId: string, reason: string) {
    const result = await this.payments.refund(rideId);
    await this.audit(actorUserId, 'REFUND', 'ride', rideId, { reason });
    return result;
  }

  async setAccountStatus(
    userId: string,
    actorUserId: string,
    input: {
      status: 'SUSPENDED' | 'BANNED' | 'ACTIVE';
      reason: string;
      suspendedUntil?: Date;
    },
  ) {
    const [user] = await this.db
      .update(users)
      .set({
        accountStatus: input.status,
        moderationReason: input.reason,
        suspendedUntil:
          input.status === 'SUSPENDED' ? input.suspendedUntil : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        accountStatus: users.accountStatus,
        suspendedUntil: users.suspendedUntil,
      });
    if (!user) throw new NotFoundException('User not found');
    await this.audit(actorUserId, 'ACCOUNT_STATUS', 'user', userId, {
      status: input.status,
      reason: input.reason,
    });
    return user;
  }

  findInvoiceGaps(financialYear: string) {
    return this.invoices.findSequenceGaps(financialYear);
  }

  findLedgerDrift(limit = 500, offset = 0) {
    return this.ledger.findBalanceDrift(limit, offset);
  }

  async repairLedgerDrift(
    driverId: string,
    actorUserId: string,
    reason: string,
  ) {
    const result = await this.ledger.repairDrift(driverId);
    await this.audit(actorUserId, 'LEDGER_DRIFT_REPAIR', 'driver', driverId, {
      reason,
      driftPaise: result.driftPaise,
    });
    return result;
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(adminAuditLog).values({
      actorUserId,
      action,
      targetType,
      targetId,
      metadata,
    });
  }
}
