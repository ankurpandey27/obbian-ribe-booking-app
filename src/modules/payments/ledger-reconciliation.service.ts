import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { drivers as driversTable } from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import { LedgerEventType } from '../../shared/events/contracts';
import { formatPaise } from '../../shared/money';
import { BalanceDrift, WalletLedgerService } from './wallet-ledger.service';
import { MetricsService } from '../../common/observability/metrics.service';

export interface ReconciliationReport {
  driversScanned: number;
  driftCount: number;
  totalDriftPaise: number;
  drifts: BalanceDrift[];
  startedAt: string;
  finishedAt: string;
}

/**
 * LedgerReconciliationService — proves the wallet cache still agrees with the
 * ledger, nightly.
 *
 * Why this job exists at all: `drivers.walletBalancePaise` is a denormalised
 * cache of `SUM(wallet_ledger.amountPaise)`. Caches drift, and a drifting
 * *financial* cache is money that appeared or vanished with no explanation. The
 * only way to know is to re-derive the truth and compare.
 *
 * Any non-zero drift is a P1: it means some code path mutated the balance
 * without writing a ledger entry. The job reports and emits an event; it does
 * NOT auto-repair, because overwriting the cache destroys the only evidence of
 * which path was buggy. Repair is a deliberate ops action via
 * `WalletLedgerService.repairDrift()`.
 *
 * Scans in batches so a large driver population never holds long locks — the
 * query is read-only and takes no row locks at all.
 */
@Injectable()
export class LedgerReconciliationService {
  private readonly logger = new Logger(LedgerReconciliationService.name);
  private readonly enabled: boolean;
  private readonly batchSize: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly ledger: WalletLedgerService,
    private readonly outbox: OutboxService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled = config.get<boolean>('ledger.reconcileEnabled', true);
    this.batchSize = config.get<number>('ledger.reconcileBatchSize', 500);
  }

  @Cron('0 4 * * *')
  async reconcileNightly(): Promise<ReconciliationReport> {
    if (!this.enabled) {
      this.logger.log('ledger reconciliation disabled, skipping run');
      return this.emptyReport();
    }
    return this.reconcileAll();
  }

  /**
   * Full sweep. Returns every disagreement found so the caller (cron log,
   * admin endpoint, or a test) can act on it.
   */
  async reconcileAll(): Promise<ReconciliationReport> {
    const startedAt = new Date().toISOString();
    const [{ total }] = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(driversTable);
    const driversScanned = Number(total);

    const drifts: BalanceDrift[] = [];
    for (let offset = 0; offset < driversScanned; offset += this.batchSize) {
      const batch = await this.ledger.findBalanceDrift(this.batchSize, offset);
      drifts.push(...batch);
    }

    const totalDriftPaise = drifts.reduce((sum, d) => sum + d.driftPaise, 0);

    if (drifts.length > 0) {
      for (const _drift of drifts) this.metrics?.recordLedgerDrift('driver');
      // Loud on purpose. A silent financial mismatch is how a platform loses
      // money for months without noticing.
      this.logger.error(
        `LEDGER DRIFT DETECTED: ${drifts.length}/${driversScanned} drivers, ` +
          `net ${formatPaise(totalDriftPaise)}. ` +
          'A write path is mutating walletBalancePaise without a ledger entry.',
      );
      for (const drift of drifts) {
        this.logger.error(
          `  driver=${drift.driverId} cache=${formatPaise(
            drift.cachedBalancePaise,
          )} ledger=${formatPaise(drift.ledgerBalancePaise)} ` +
            `drift=${formatPaise(drift.driftPaise)}`,
        );
        await this.emitDrift(drift);
      }
    } else {
      this.logger.log(
        `ledger reconciliation clean: ${driversScanned} drivers, no drift`,
      );
    }

    return {
      driversScanned,
      driftCount: drifts.length,
      totalDriftPaise,
      drifts,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * Emit one drift event per affected driver so alerting/consumers can page
   * on it. Fire-and-forget relative to the scan: a failure to publish must not
   * abort the remaining reconciliation.
   */
  private async emitDrift(drift: BalanceDrift): Promise<void> {
    try {
      await this.outbox.write(this.db, {
        topic: TOPICS.LEDGER_EVENTS,
        type: LedgerEventType.BALANCE_DRIFT_DETECTED,
        aggregateType: 'driver_wallet',
        aggregateId: drift.driverId,
        payload: {
          driverId: drift.driverId,
          cachedBalancePaise: drift.cachedBalancePaise,
          ledgerBalancePaise: drift.ledgerBalancePaise,
          driftPaise: drift.driftPaise,
          detectedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      this.logger.error(
        `failed to emit drift event for driver=${drift.driverId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  private emptyReport(): ReconciliationReport {
    const now = new Date().toISOString();
    return {
      driversScanned: 0,
      driftCount: 0,
      totalDriftPaise: 0,
      drifts: [],
      startedAt: now,
      finishedAt: now,
    };
  }
}
