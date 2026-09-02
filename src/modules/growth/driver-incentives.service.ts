import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, lte } from 'drizzle-orm';
import { Cron } from '@nestjs/schedule';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { driverIncentives } from '../../common/database/schema';
import { WalletLedgerService } from '../payments/wallet-ledger.service';

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

@Injectable()
export class DriverIncentivesService {
  private readonly enabled: boolean;
  private readonly maxBonusPaise: number;
  private readonly payoutBatchSize: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly ledger: WalletLedgerService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('incentive.enabled', true);
    this.maxBonusPaise = config.get<number>('incentive.maxBonusPaise', 500000);
    this.payoutBatchSize = config.get<number>('incentive.payoutBatchSize', 200);
  }

  async create(input: {
    driverId: string;
    incentiveType: string;
    title: string;
    targetRides: number;
    bonusPaise: number;
    periodStart: Date;
    periodEnd: Date;
    city?: string;
  }) {
    if (!this.enabled) throw new BadRequestException('Incentives are disabled');
    if (input.bonusPaise > this.maxBonusPaise) {
      throw new BadRequestException('Incentive bonus exceeds configured limit');
    }
    if (input.periodEnd <= input.periodStart) {
      throw new BadRequestException('periodEnd must be after periodStart');
    }
    const [row] = await this.db
      .insert(driverIncentives)
      .values(input)
      .returning();
    return row;
  }

  async listForDriver(driverId: string) {
    return this.db
      .select()
      .from(driverIncentives)
      .where(eq(driverIncentives.driverId, driverId))
      .orderBy(desc(driverIncentives.periodEnd))
      .limit(100);
  }

  async recordRideCompletion(
    driverId: string,
    earningPaise: number,
    existingTx?: Tx,
  ) {
    const run = async (tx: Tx) => {
      const active = await tx
        .select()
        .from(driverIncentives)
        .where(
          and(
            eq(driverIncentives.driverId, driverId),
            eq(driverIncentives.status, 'ACTIVE'),
            lte(driverIncentives.periodStart, new Date()),
          ),
        )
        .for('update');
      for (const incentive of active) {
        const completedRides = incentive.completedRides + 1;
        const achievedEarningsPaise =
          incentive.achievedEarningsPaise + earningPaise;
        const achieved =
          (incentive.targetRides > 0 &&
            completedRides >= incentive.targetRides) ||
          (incentive.targetEarningsPaise > 0 &&
            achievedEarningsPaise >= incentive.targetEarningsPaise);
        await tx
          .update(driverIncentives)
          .set({
            completedRides,
            achievedEarningsPaise,
            status: achieved ? 'ACHIEVED' : 'ACTIVE',
            achievedAt: achieved ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(driverIncentives.id, incentive.id));
      }
    };
    return existingTx ? run(existingTx) : this.db.transaction(run);
  }

  @Cron('15 3 * * *')
  async payoutAchieved(): Promise<number> {
    if (!this.enabled) return 0;
    const rows = await this.db
      .select()
      .from(driverIncentives)
      .where(eq(driverIncentives.status, 'ACHIEVED'))
      .orderBy(driverIncentives.achievedAt)
      .limit(this.payoutBatchSize);
    let paid = 0;
    for (const incentive of rows) {
      const didPay = await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(driverIncentives)
          .where(
            and(
              eq(driverIncentives.id, incentive.id),
              eq(driverIncentives.status, 'ACHIEVED'),
            ),
          )
          .limit(1)
          .for('update');
        if (!locked) return false;
        const entry = await this.ledger.write(
          {
            driverId: locked.driverId,
            entryType: 'INCENTIVE_CREDIT',
            amountPaise: locked.bonusPaise,
            idempotencyKey: `incentive:${locked.id}`,
            referenceType: 'driver_incentive',
            referenceId: locked.id,
          },
          tx,
        );
        await tx
          .update(driverIncentives)
          .set({
            status: 'PAID',
            ledgerEntryId: entry?.id ?? locked.ledgerEntryId,
            paidAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(driverIncentives.id, locked.id));
        return true;
      });
      if (didPay) paid += 1;
    }
    return paid;
  }
}
