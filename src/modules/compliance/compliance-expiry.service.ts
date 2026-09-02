import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import { ComplianceEventType } from '../../shared/events/contracts';
import { DriverDocumentsService } from './driver-documents.service';

export interface ExpirySweepReport {
  expiredCount: number;
  affectedDrivers: number;
  warningsSent: number;
  startedAt: string;
  finishedAt: string;
}

/**
 * ComplianceExpirySweepService — keeps dispatch eligibility honest over time.
 *
 * A verified document is only valid until its expiry date. Checking that on the
 * matching hot path would add a date comparison to every dispatch decision, so
 * instead a nightly sweep flips lapsed documents to EXPIRED and revokes the
 * driver's `isComplianceVerified` flag. Matching then reads one boolean from a
 * partial index, as it does today.
 *
 * The sweep also warns drivers ahead of time. Silently revoking a captain's
 * income at midnight because their insurance lapsed — with no prior notice — is
 * the kind of thing that loses supply.
 */
@Injectable()
export class ComplianceExpirySweepService {
  private readonly logger = new Logger(ComplianceExpirySweepService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly documents: DriverDocumentsService,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('compliance.expirySweepEnabled', true);
  }

  @Cron('30 2 * * *')
  async sweepNightly(): Promise<ExpirySweepReport> {
    if (!this.enabled) {
      this.logger.log('compliance expiry sweep disabled, skipping run');
      return this.emptyReport();
    }
    return this.runSweep();
  }

  /**
   * Warn first, then expire. Order matters: expiring first would move the
   * document out of VERIFIED, so `findExpiringSoon` would no longer see it and
   * the driver would never get the warning that explains the revocation.
   */
  async runSweep(now = new Date()): Promise<ExpirySweepReport> {
    const startedAt = new Date().toISOString();

    const warningsSent = await this.sendRenewalWarnings(now);
    const { expiredCount, affectedDrivers } =
      await this.documents.expireLapsedDocuments(now);

    if (expiredCount > 0) {
      this.logger.warn(
        `compliance sweep: ${expiredCount} document(s) expired, ` +
          `${affectedDrivers.length} driver(s) lost dispatch eligibility`,
      );
    } else {
      this.logger.log(
        `compliance sweep clean: nothing expired, ${warningsSent} renewal warning(s) sent`,
      );
    }

    return {
      expiredCount,
      affectedDrivers: affectedDrivers.length,
      warningsSent,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * Emit DOCUMENT_EXPIRING_SOON per lapsing document. The notification module
   * consumes this; the sweep itself stays free of transport concerns.
   */
  private async sendRenewalWarnings(now: Date): Promise<number> {
    const expiring = await this.documents.findExpiringSoon(now);
    let sent = 0;

    for (const doc of expiring) {
      try {
        await this.outbox.write(this.db, {
          topic: TOPICS.COMPLIANCE_EVENTS,
          type: ComplianceEventType.DOCUMENT_EXPIRING_SOON,
          aggregateType: 'driver',
          aggregateId: doc.driverId,
          payload: {
            driverId: doc.driverId,
            documentId: doc.documentId,
            documentType: doc.documentType,
            status: 'VERIFIED',
            expiresAt: doc.expiresAt.toISOString(),
            reason: `expires in ${doc.daysUntilExpiry} day(s)`,
            occurredAt: now.toISOString(),
          },
        });
        sent += 1;
      } catch (err) {
        // A failed warning must not abort the expiry pass.
        this.logger.error(
          `failed to emit expiry warning for document=${doc.documentId}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return sent;
  }

  private emptyReport(): ExpirySweepReport {
    const now = new Date().toISOString();
    return {
      expiredCount: 0,
      affectedDrivers: 0,
      warningsSent: 0,
      startedAt: now,
      finishedAt: now,
    };
  }
}
