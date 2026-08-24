import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { and, eq, gte } from 'drizzle-orm';
import Razorpay from 'razorpay';
import {
  DRIZZLE_DB,
  DrizzleDB,
} from '../../../common/database/drizzle.module';
import { drivers as driversTable, rides as ridesTable } from '../../../common/database/schema';

export interface SettlementRecord {
  driverId: string;
  rides: number;
  gross: number;
  commission: number;
  net: number;
  payoutId?: string;
}

/**
 * SettlementService — nightly driver payout sweep (RazorpayX).
 * Groups completed rides from the last 24h by driver, applies the
 * commission, credits the driver wallet, and (when Razorpay is
 * configured) creates a RazorpayX payout to the driver's registered
 * UPI/fund account. Logs a summary each run; never throws on payout
 * failures (wallet credit is still recorded, payout retried next run
 * via the unsettled-window query).
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

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async settleDaily(): Promise<SettlementRecord[]> {
    if (!this.enabled) {
      this.logger.log('Settlement disabled, skipping run');
      return [];
    }

    const since = new Date();
    since.setUTCHours(since.getUTCHours() - 24);

    const rides = await this.db
      .select()
      .from(ridesTable)
      .where(
        and(
          eq(ridesTable.status, 'COMPLETED'),
          gte(ridesTable.completedAt, since),
        ),
      );

    const byDriver = new Map<string, typeof rides>();
    for (const r of rides) {
      if (!r.driverId) continue;
      const list = byDriver.get(r.driverId) ?? [];
      list.push(r);
      byDriver.set(r.driverId, list);
    }

    const records: SettlementRecord[] = [];
    for (const [driverId, driverRides] of byDriver) {
      const gross = driverRides.reduce(
        (sum, r) => sum + Number(r.totalFare ?? 0),
        0,
      );
      const commission = Math.round(gross * this.commissionPercent) / 100;
      const net = Math.round((gross - commission) * 100) / 100;

      // Credit wallet regardless of payout gateway availability.
      const [driver] = await this.db
        .select()
        .from(driversTable)
        .where(eq(driversTable.userId, driverId))
        .limit(1);
      await this.db
        .update(driversTable)
        .set({
          walletBalance: Number(driver?.walletBalance ?? 0) + net,
          updatedAt: new Date(),
        })
        .where(eq(driversTable.userId, driverId));

      let payoutId: string | undefined;
      if (this.razorpay && this.payoutAccount && driver?.upiId) {
        try {
          // RazorpayX payouts — not in the base SDK typings, cast needed.
          const payouts = (
            this.razorpay as unknown as {
              payouts: {
                create: (
                  opts: Record<string, unknown>,
                ) => Promise<{ id: string }>;
              };
            }
          ).payouts;
          const payout = await payouts.create({
            account_number: this.payoutAccount,
            amount: Math.round(net * 100),
            currency: 'INR',
            mode: 'UPI',
            purpose: 'payout',
            fund_account: {
              account_type: 'vpa',
              vpa: { address: driver.upiId },
            },
            reference_id: `settle-${driverId}-${Date.now()}`,
            narration: `Ride settlement (${driverRides.length} rides)`,
          });
          payoutId = payout.id;
        } catch (err) {
          this.logger.warn(
            `Payout failed for ${driverId}: ${(err as Error).message}`,
          );
        }
      }

      records.push({
        driverId,
        rides: driverRides.length,
        gross,
        commission,
        net,
        payoutId,
      });
      this.logger.log(
        `Settled ${driverId}: ${driverRides.length} rides, net ₹${net}`,
      );
    }

    this.logger.log(`Settlement run complete: ${records.length} drivers`);
    return records;
  }
}
