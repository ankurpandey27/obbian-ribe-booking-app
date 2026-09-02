import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import Razorpay from 'razorpay';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  drivers as driversTable,
  rides as ridesTable,
  settlements as settlementsTable,
} from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import { LedgerEventType } from '../../shared/events/contracts';
import { formatPaise, percentOf, toPaise } from '../../shared/money';
import { SettlementStatusValue } from '../../shared/types/common';
import { WalletLedgerService } from './wallet-ledger.service';

export interface SettlementRecord {
  settlementId: string;
  driverId: string;
  rideCount: number;
  grossPaise: number;
  commissionPaise: number;
  netPayoutPaise: number;
  status: SettlementStatusValue;
  payoutReference?: string;
  failureReason?: string;
}

interface DriverPeriodTotals {
  driverId: string;
  rideCount: number;
  grossPaise: number;
}

/** Razorpay payout surface — absent from the SDK typings. */
interface RazorpayPayouts {
  payouts: {
    create: (opts: Record<string, unknown>) => Promise<{ id: string }>;
  };
}

/**
 * SettlementService — nightly driver payout sweep.
 *
 * What the previous implementation got wrong, and what changed:
 *
 *  1. It read `drivers.walletBalance` and wrote back `balance + net`. Two
 *     overlapping runs, or one retry, silently double-credited. Now every
 *     credit goes through WalletLedgerService with an idempotency key derived
 *     from (driverId, period), so a retry is a no-op.
 *  2. It recorded nothing. "Why did driver X receive ₹Y on date Z" had no
 *     answer. Now every run writes a `settlements` row with the full
 *     gross/commission/net breakdown and the payout reference.
 *  3. A failed gateway payout was logged and forgotten while the wallet had
 *     already been credited — the driver's balance said paid, the bank said
 *     otherwise. Now the run is a two-phase state machine: LEDGERED (money
 *     owed, recorded) → PAID (gateway confirmed). A failure leaves the row
 *     FAILED and the balance intact, and the next sweep retries it.
 *  4. Its window was `now() - 24h` at run time, so a late run silently skipped
 *     rides. The window is now aligned to whole days and the UNIQUE on
 *     (driverId, periodStart, periodEnd) makes re-running a window safe.
 *
 * Money is computed in integer paise throughout; the rupee columns on `rides`
 * are converted once at read.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private readonly enabled: boolean;
  private readonly commissionPercent: number;
  private readonly payoutAccount?: string;
  private readonly razorpay: Razorpay | null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly ledger: WalletLedgerService,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('settlement.enabled', true);
    this.commissionPercent = config.get<number>(
      'settlement.commissionPercent',
      20,
    );
    this.payoutAccount = config.get<string>('razorpay.payoutAccount');
    const keyId = config.get<string>('razorpay.keyId');
    const keySecret = config.get<string>('razorpay.keySecret');
    this.razorpay =
      keyId && keySecret
        ? new Razorpay({ key_id: keyId, key_secret: keySecret })
        : null;
  }

  /**
   * Nightly entry point. Settles the previous whole UTC day, then retries any
   * earlier run still stuck in LEDGERED/FAILED.
   */
  @Cron('0 3 * * *')
  async settleDaily(): Promise<SettlementRecord[]> {
    if (!this.enabled) {
      this.logger.log('settlement disabled, skipping run');
      return [];
    }

    const { periodStart, periodEnd } = this.previousDayWindow();
    const records = await this.settlePeriod(periodStart, periodEnd);

    // Separate pass: money already owed but not yet in the driver's bank.
    const retried = await this.retryUnpaidPayouts();

    this.logger.log(
      `settlement run complete: ${records.length} settled, ${retried.length} payouts retried`,
    );
    return [...records, ...retried];
  }

  /**
   * Settle one explicit window. Safe to call repeatedly for the same window —
   * the UNIQUE on (driverId, periodStart, periodEnd) turns a second attempt
   * into a resume rather than a double payment.
   */
  async settlePeriod(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SettlementRecord[]> {
    const totals = await this.aggregateCompletedRides(periodStart, periodEnd);
    if (totals.length === 0) {
      this.logger.log(
        `no completed rides in ${periodStart.toISOString()}..${periodEnd.toISOString()}`,
      );
      return [];
    }

    const records: SettlementRecord[] = [];
    for (const total of totals) {
      try {
        records.push(await this.settleDriver(total, periodStart, periodEnd));
      } catch (err) {
        // One driver's failure must not abort the remaining payouts.
        this.logger.error(
          `settlement failed for driver=${total.driverId}: ${
            (err as Error).message
          }`,
        );
      }
    }
    return records;
  }

  /**
   * Per-driver settlement. Phase 1 (this method) records the amount owed and
   * credits the wallet inside ONE transaction. Phase 2 (`executePayout`) talks
   * to the gateway outside that transaction, because an external HTTP call
   * must never hold a DB transaction open.
   */
  private async settleDriver(
    totals: DriverPeriodTotals,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SettlementRecord> {
    const commissionPaise = percentOf(
      totals.grossPaise,
      this.commissionPercent,
    );
    const netPayoutPaise = totals.grossPaise - commissionPaise;

    const settlement = await this.db.transaction(async (tx) => {
      // Claim the window. ON CONFLICT DO NOTHING + re-read is what makes a
      // concurrent or repeated run resume instead of duplicate.
      const [created] = await tx
        .insert(settlementsTable)
        .values({
          driverId: totals.driverId,
          periodStart,
          periodEnd,
          rideCount: totals.rideCount,
          grossPaise: totals.grossPaise,
          commissionPaise,
          netPayoutPaise,
          commissionPercent: this.commissionPercent,
          status: 'PENDING',
        })
        .onConflictDoNothing({
          target: [
            settlementsTable.driverId,
            settlementsTable.periodStart,
            settlementsTable.periodEnd,
          ],
        })
        .returning();

      if (!created) {
        // Window already claimed by an earlier run.
        const [existing] = await tx
          .select()
          .from(settlementsTable)
          .where(
            and(
              eq(settlementsTable.driverId, totals.driverId),
              eq(settlementsTable.periodStart, periodStart),
              eq(settlementsTable.periodEnd, periodEnd),
            ),
          )
          .limit(1);
        return existing;
      }

      // Credit the driver's share and debit the platform commission as two
      // entries, so the ledger shows the gross the rider paid and the cut
      // taken rather than only the net.
      await this.ledger.writeMany(
        [
          {
            driverId: totals.driverId,
            entryType: 'RIDE_EARNING',
            amountPaise: totals.grossPaise,
            idempotencyKey: this.earningKey(created.id),
            referenceType: 'settlement',
            referenceId: created.id,
          },
          {
            driverId: totals.driverId,
            entryType: 'COMMISSION_DEBIT',
            amountPaise: commissionPaise,
            idempotencyKey: this.commissionKey(created.id),
            referenceType: 'settlement',
            referenceId: created.id,
          },
        ],
        tx,
      );

      const [ledgered] = await tx
        .update(settlementsTable)
        .set({
          status: 'LEDGERED',
          ledgeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(settlementsTable.id, created.id),
            eq(settlementsTable.status, 'PENDING'),
          ),
        )
        .returning();

      await this.outbox.write(tx, {
        topic: TOPICS.LEDGER_EVENTS,
        type: LedgerEventType.SETTLEMENT_LEDGERED,
        aggregateType: 'settlement',
        aggregateId: created.id,
        payload: this.eventPayload(ledgered ?? created),
      });

      return ledgered ?? created;
    });

    if (!settlement) {
      throw new Error(
        `settlement row missing for driver=${totals.driverId} period=${periodStart.toISOString()}`,
      );
    }

    // Already paid on a previous run — nothing further to do.
    if (settlement.status === 'PAID') {
      return this.toRecord(settlement);
    }

    return this.executePayout(settlement.id);
  }

  /**
   * Phase 2 — move the money at the gateway.
   *
   * Runs OUTSIDE the ledger transaction on purpose: a gateway call can hang for
   * seconds, and holding a transaction (plus the driver row lock) for that long
   * would stall every other write to that wallet.
   *
   * The wallet is already credited at this point, so a failure here is
   * recoverable: the row stays FAILED, the driver's balance still shows the
   * money as owed, and the next sweep retries. Nothing is lost, nothing is paid
   * twice — the gateway's own `reference_id` is derived from the settlement id,
   * so a retry after a timeout that actually succeeded is rejected by Razorpay
   * as a duplicate rather than paying again.
   */
  async executePayout(settlementId: string): Promise<SettlementRecord> {
    const [settlement] = await this.db
      .select()
      .from(settlementsTable)
      .where(eq(settlementsTable.id, settlementId))
      .limit(1);

    if (!settlement) {
      throw new NotFoundException(`Settlement ${settlementId} not found`);
    }
    if (settlement.status === 'PAID') {
      return this.toRecord(settlement);
    }
    if (settlement.netPayoutPaise <= 0) {
      // Nothing owed (all commission, or a fully-refunded period).
      const [closed] = await this.db
        .update(settlementsTable)
        .set({ status: 'PAID', paidAt: new Date(), updatedAt: new Date() })
        .where(eq(settlementsTable.id, settlementId))
        .returning();
      return this.toRecord(closed ?? settlement);
    }

    const [driver] = await this.db
      .select({
        upiId: driversTable.upiId,
        bankAccount: driversTable.bankAccount,
      })
      .from(driversTable)
      .where(eq(driversTable.userId, settlement.driverId))
      .limit(1);

    const gatewayReady =
      this.razorpay !== null &&
      Boolean(this.payoutAccount) &&
      Boolean(driver?.upiId);

    if (!gatewayReady) {
      // Gateway not configured (local/dev) or the driver has no payout
      // destination. The money stays owed and visible in the ledger; this is
      // recorded as FAILED with a precise reason rather than pretended-paid.
      const reason = !this.razorpay
        ? 'razorpay not configured'
        : !this.payoutAccount
          ? 'RAZORPAY_PAYOUT_ACCOUNT not set'
          : 'driver has no UPI id on file';
      return this.markFailed(settlementId, reason);
    }

    try {
      const payouts = (this.razorpay as unknown as RazorpayPayouts).payouts;
      const payout = await payouts.create({
        account_number: this.payoutAccount,
        amount: settlement.netPayoutPaise, // already paise — no ×100
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        fund_account: {
          account_type: 'vpa',
          vpa: { address: driver?.upiId },
        },
        // Derived from the settlement id, NOT Date.now(): a retry after an
        // ambiguous timeout reuses the same reference so the gateway rejects
        // the duplicate instead of paying twice.
        reference_id: `settle-${settlementId}`,
        narration: `Obbian settlement (${settlement.rideCount} rides)`,
      });

      return this.markPaid(settlementId, payout.id);
    } catch (err) {
      return this.markFailed(settlementId, (err as Error).message);
    }
  }

  /**
   * Retry sweep for settlements whose money is owed but not delivered.
   * Bounded so one bad night cannot make the nightly job run unboundedly long.
   */
  async retryUnpaidPayouts(limit = 100): Promise<SettlementRecord[]> {
    const stuck = await this.db
      .select({ id: settlementsTable.id })
      .from(settlementsTable)
      .where(
        and(
          inArray(settlementsTable.status, ['LEDGERED', 'FAILED']),
          // Give up automatic retries after 5 attempts; ops takes over.
          lt(settlementsTable.attempts, 5),
        ),
      )
      .orderBy(asc(settlementsTable.createdAt))
      .limit(limit);

    const records: SettlementRecord[] = [];
    for (const row of stuck) {
      try {
        records.push(await this.executePayout(row.id));
      } catch (err) {
        this.logger.error(
          `payout retry failed for settlement=${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return records;
  }

  /** Settlement history for a driver — the "where did my money go" surface. */
  async getSettlementsForDriver(
    driverId: string,
    limit = 20,
    offset = 0,
  ): Promise<SettlementRecord[]> {
    const rows = await this.db
      .select()
      .from(settlementsTable)
      .where(eq(settlementsTable.driverId, driverId))
      .orderBy(sql`${settlementsTable.periodStart} DESC`)
      .limit(Math.min(limit, 100))
      .offset(offset);
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * Gross earnings per driver for the window, from COMPLETED rides.
   *
   * One grouped query rather than fetching every ride and reducing in JS —
   * the previous implementation loaded the full day's rides into memory, which
   * does not survive 1M rides/day. Backed by IDX_rides_settlement_sweep.
   */
  private async aggregateCompletedRides(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<DriverPeriodTotals[]> {
    const rows = await this.db
      .select({
        driverId: ridesTable.driverId,
        rideCount: sql<number>`COUNT(*)::int`,
        // Sum in SQL as numeric, convert to paise once. Avoids float drift
        // across thousands of rupee values.
        grossRupees: sql<string>`COALESCE(SUM(${ridesTable.totalFare}), 0)::text`,
      })
      .from(ridesTable)
      .where(
        and(
          eq(ridesTable.status, 'COMPLETED'),
          // Only settle rides whose payment actually captured — excludes rides
          // that were never paid or were later refunded (money leak guard).
          eq(ridesTable.paymentStatus, 'COMPLETED'),
          gte(ridesTable.completedAt, periodStart),
          lt(ridesTable.completedAt, periodEnd),
          sql`${ridesTable.driverId} IS NOT NULL`,
        ),
      )
      .groupBy(ridesTable.driverId);

    return rows
      .filter((r): r is typeof r & { driverId: string } => r.driverId !== null)
      .map((r) => ({
        driverId: r.driverId,
        rideCount: Number(r.rideCount),
        grossPaise: toPaise(Number(r.grossRupees)),
      }))
      .filter((r) => r.grossPaise > 0);
  }

  private async markPaid(
    settlementId: string,
    payoutReference: string,
  ): Promise<SettlementRecord> {
    const [updated] = await this.db.transaction(async (tx) => {
      // Conditional update: only a not-yet-PAID row transitions, so two
      // concurrent retries cannot both emit SETTLEMENT_PAID.
      const rows = await tx
        .update(settlementsTable)
        .set({
          status: 'PAID',
          payoutReference,
          payoutMode: 'UPI',
          paidAt: new Date(),
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(settlementsTable.id, settlementId),
            inArray(settlementsTable.status, ['LEDGERED', 'FAILED', 'PENDING']),
          ),
        )
        .returning();

      if (rows.length > 0) {
        await this.outbox.write(tx, {
          topic: TOPICS.LEDGER_EVENTS,
          type: LedgerEventType.SETTLEMENT_PAID,
          aggregateType: 'settlement',
          aggregateId: settlementId,
          payload: this.eventPayload(rows[0]),
        });
      }
      return rows;
    });

    if (!updated) {
      // Lost the race; the winner already marked it paid.
      const [current] = await this.db
        .select()
        .from(settlementsTable)
        .where(eq(settlementsTable.id, settlementId))
        .limit(1);
      return this.toRecord(current);
    }

    this.logger.log(
      `settlement ${settlementId} paid: ${formatPaise(
        updated.netPayoutPaise,
      )} ref=${payoutReference}`,
    );
    return this.toRecord(updated);
  }

  private async markFailed(
    settlementId: string,
    failureReason: string,
  ): Promise<SettlementRecord> {
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(settlementsTable)
        .set({
          status: 'FAILED',
          failureReason: failureReason.slice(0, 500),
          attempts: sql`${settlementsTable.attempts} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(settlementsTable.id, settlementId))
        .returning();

      if (rows.length > 0) {
        await this.outbox.write(tx, {
          topic: TOPICS.LEDGER_EVENTS,
          type: LedgerEventType.SETTLEMENT_FAILED,
          aggregateType: 'settlement',
          aggregateId: settlementId,
          payload: this.eventPayload(rows[0]),
        });
      }
      return rows;
    });

    this.logger.warn(
      `settlement ${settlementId} payout failed (attempt ${
        updated?.attempts ?? '?'
      }): ${failureReason}`,
    );
    return this.toRecord(updated);
  }

  /**
   * Previous whole UTC day, [start, end). Aligned to day boundaries rather
   * than `now() - 24h` so a run that starts late still settles exactly the
   * intended day and never leaves a gap.
   */
  private previousDayWindow(): { periodStart: Date; periodEnd: Date } {
    const periodEnd = new Date();
    periodEnd.setUTCHours(0, 0, 0, 0);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(periodStart.getUTCDate() - 1);
    return { periodStart, periodEnd };
  }

  /** Stable idempotency keys — derived from the settlement id, never a clock. */
  private earningKey(settlementId: string): string {
    return `settlement:${settlementId}:earning`;
  }

  private commissionKey(settlementId: string): string {
    return `settlement:${settlementId}:commission`;
  }

  private eventPayload(
    row: typeof settlementsTable.$inferSelect,
  ): Record<string, unknown> {
    return {
      settlementId: row.id,
      driverId: row.driverId,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      rideCount: row.rideCount,
      grossPaise: row.grossPaise,
      commissionPaise: row.commissionPaise,
      netPayoutPaise: row.netPayoutPaise,
      status: row.status,
      payoutReference: row.payoutReference ?? undefined,
      failureReason: row.failureReason ?? undefined,
      occurredAt: new Date().toISOString(),
    };
  }

  private toRecord(
    row: typeof settlementsTable.$inferSelect,
  ): SettlementRecord {
    return {
      settlementId: row.id,
      driverId: row.driverId,
      rideCount: row.rideCount,
      grossPaise: row.grossPaise,
      commissionPaise: row.commissionPaise,
      netPayoutPaise: row.netPayoutPaise,
      status: row.status,
      payoutReference: row.payoutReference ?? undefined,
      failureReason: row.failureReason ?? undefined,
    };
  }
}
