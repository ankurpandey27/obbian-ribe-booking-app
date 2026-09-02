import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { cancellationPenalties } from '../../common/database/schema';
import { WalletLedgerService } from '../payments/wallet-ledger.service';
import { IncidentsService } from './incidents.service';
import { CancellationReasonValue } from '../../shared/types/common';

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export interface PenaltyEvaluation {
  offenceIndex: number;
  penaltyPaise: number;
}

@Injectable()
export class CancellationPenaltiesService {
  private readonly graceMinutes: number;
  private readonly windowHours: number;
  private readonly riderTiers: number[];
  private readonly driverTiers: number[];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly ledger: WalletLedgerService,
    private readonly incidents: IncidentsService,
    config: ConfigService,
  ) {
    this.graceMinutes = config.get<number>('cancellation.graceMinutes', 2);
    this.windowHours = config.get<number>('cancellation.windowHours', 24);
    this.riderTiers = config.get<number[]>(
      'cancellation.riderPenaltyTiersPaise',
      [2000, 5000, 10000],
    );
    this.driverTiers = config.get<number[]>(
      'cancellation.driverPenaltyTiersPaise',
      [5000, 10000, 20000],
    );
  }

  async evaluate(
    userId: string,
    role: 'RIDER' | 'DRIVER',
    createdAt: Date,
  ): Promise<PenaltyEvaluation> {
    const [row] = await this.db
      .select({ value: count() })
      .from(cancellationPenalties)
      .where(
        and(
          eq(cancellationPenalties.userId, userId),
          eq(cancellationPenalties.role, role),
          eq(cancellationPenalties.isWaived, false),
          gt(
            cancellationPenalties.createdAt,
            new Date(Date.now() - this.windowHours * 60 * 60 * 1000),
          ),
        ),
      );
    const offenceIndex = Number(row?.value ?? 0) + 1;
    const minutes = (Date.now() - createdAt.getTime()) / 60000;
    if (minutes <= this.graceMinutes) return { offenceIndex, penaltyPaise: 0 };
    const tiers = role === 'RIDER' ? this.riderTiers : this.driverTiers;
    return {
      offenceIndex,
      penaltyPaise: tiers[Math.min(offenceIndex - 1, tiers.length - 1)] ?? 0,
    };
  }

  async record(
    input: {
      userId: string;
      rideId: string;
      role: 'RIDER' | 'DRIVER';
      reason: CancellationReasonValue;
      createdAt: Date;
      driverId?: string;
    },
    existingTx?: Tx,
    evaluationOverride?: PenaltyEvaluation,
  ) {
    const evaluation =
      evaluationOverride ??
      (await this.evaluate(input.userId, input.role, input.createdAt));
    const run = async (tx: Tx) => {
      const [row] = await tx
        .insert(cancellationPenalties)
        .values({
          userId: input.userId,
          rideId: input.rideId,
          role: input.role,
          reason: input.reason,
          offenceIndex: evaluation.offenceIndex,
          penaltyPaise: evaluation.penaltyPaise,
          minutesSinceRequest: Math.max(
            0,
            (Date.now() - input.createdAt.getTime()) / 60000,
          ),
        })
        .returning();
      if (
        input.role === 'DRIVER' &&
        input.driverId &&
        evaluation.penaltyPaise > 0
      ) {
        await this.ledger.write(
          {
            driverId: input.driverId,
            entryType: 'PENALTY_DEBIT',
            amountPaise: evaluation.penaltyPaise,
            idempotencyKey: `cancellation:${input.rideId}:${input.driverId}`,
            referenceType: 'cancellation_penalty',
            referenceId: row.id,
          },
          tx,
        );
      }
      return { row, ...evaluation };
    };
    return existingTx ? run(existingTx) : this.db.transaction(run);
  }

  async listForUser(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(cancellationPenalties)
      .where(eq(cancellationPenalties.userId, userId))
      .orderBy(desc(cancellationPenalties.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .offset(Math.max(offset, 0));
  }

  async waive(id: string, actorUserId: string, reason: string) {
    const [row] = await this.db
      .update(cancellationPenalties)
      .set({
        isWaived: true,
        waivedReason: reason,
        waivedByUserId: actorUserId,
        waivedAt: new Date(),
      })
      .where(
        and(
          eq(cancellationPenalties.id, id),
          eq(cancellationPenalties.isWaived, false),
        ),
      )
      .returning();
    if (!row)
      throw new NotFoundException('Penalty not found or already waived');
    return row;
  }

  async dispute(id: string, userId: string, reason: string) {
    const [penalty] = await this.db
      .select()
      .from(cancellationPenalties)
      .where(
        and(
          eq(cancellationPenalties.id, id),
          eq(cancellationPenalties.userId, userId),
        ),
      )
      .limit(1);
    if (!penalty) throw new NotFoundException('Penalty not found');
    const incident = await this.incidents.create(userId, {
      incidentType: 'OVERCHARGE',
      description: `Cancellation penalty dispute: ${reason}`,
      rideId: penalty.rideId,
    });
    return { incidentReference: incident.reference };
  }
}
