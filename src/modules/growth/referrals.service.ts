import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  referralCodes,
  referralRedemptions,
  users,
} from '../../common/database/schema';

type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

@Injectable()
export class ReferralsService {
  private readonly enabled: boolean;
  private readonly refereeRewardPaise: number;
  private readonly referrerRewardPaise: number;
  private readonly qualifyingRides: number;
  private readonly codeLength: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('referral.enabled', true);
    this.refereeRewardPaise = config.get<number>(
      'referral.refereeRewardPaise',
      5000,
    );
    this.referrerRewardPaise = config.get<number>(
      'referral.referrerRewardPaise',
      10000,
    );
    this.qualifyingRides = config.get<number>('referral.qualifyingRides', 1);
    this.codeLength = Math.min(
      16,
      Math.max(6, config.get<number>('referral.codeLength', 8)),
    );
  }

  async createCode(ownerUserId: string) {
    if (!this.enabled)
      throw new BadRequestException('Referral programme is disabled');
    const existing = await this.db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.ownerUserId, ownerUserId))
      .limit(1);
    if (existing[0]) return this.viewCode(existing[0]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = this.generateCode();
      try {
        const created = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(referralCodes)
            .values({
              code,
              ownerUserId,
              refereeRewardPaise: this.refereeRewardPaise,
              referrerRewardPaise: this.referrerRewardPaise,
              qualifyingRides: this.qualifyingRides,
              maxRedemptions: 0,
            })
            .returning();
          await tx
            .update(users)
            .set({ referralCode: code, updatedAt: new Date() })
            .where(eq(users.id, ownerUserId));
          return row;
        });
        return this.viewCode(created);
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
      }
    }
    throw new BadRequestException('Could not allocate a referral code');
  }

  async redeem(refereeUserId: string, rawCode: string) {
    if (!this.enabled)
      throw new BadRequestException('Referral programme is disabled');
    const code = rawCode.trim().toUpperCase();
    return this.db.transaction(async (tx) => {
      const [definition] = await tx
        .select()
        .from(referralCodes)
        .where(
          and(eq(referralCodes.code, code), eq(referralCodes.isActive, true)),
        )
        .limit(1)
        .for('update');
      if (!definition)
        throw new BadRequestException('Referral code is invalid');
      if (definition.ownerUserId === refereeUserId) {
        throw new BadRequestException(
          'You cannot redeem your own referral code',
        );
      }
      const now = new Date();
      if (
        (definition.validFrom && definition.validFrom > now) ||
        (definition.validUntil && definition.validUntil < now)
      ) {
        throw new BadRequestException(
          'Referral code is outside its validity window',
        );
      }
      if (
        definition.maxRedemptions > 0 &&
        definition.redemptionCount >= definition.maxRedemptions
      ) {
        throw new BadRequestException('Referral code has reached its limit');
      }
      const [redemption] = await tx
        .insert(referralRedemptions)
        .values({
          referralCodeId: definition.id,
          referrerUserId: definition.ownerUserId,
          refereeUserId,
          referrerRewardPaise: definition.referrerRewardPaise,
          refereeRewardPaise: definition.refereeRewardPaise,
        })
        .returning();
      await tx
        .update(referralCodes)
        .set({ redemptionCount: sql`${referralCodes.redemptionCount} + 1` })
        .where(eq(referralCodes.id, definition.id));
      return { redemptionId: redemption.id, status: redemption.status };
    });
  }

  async getStatus(refereeUserId: string) {
    const [row] = await this.db
      .select()
      .from(referralRedemptions)
      .where(eq(referralRedemptions.refereeUserId, refereeUserId))
      .limit(1);
    return row ?? null;
  }

  async recordQualifyingRide(
    refereeUserId: string,
    rideId: string,
    existingTx?: Tx,
  ) {
    const run = async (tx: Tx) => {
      const [redemption] = await tx
        .select()
        .from(referralRedemptions)
        .where(
          and(
            eq(referralRedemptions.refereeUserId, refereeUserId),
            eq(referralRedemptions.status, 'PENDING'),
          ),
        )
        .limit(1)
        .for('update');
      if (!redemption) return false;
      const [code] = await tx
        .select({ qualifyingRides: referralCodes.qualifyingRides })
        .from(referralCodes)
        .where(eq(referralCodes.id, redemption.referralCodeId))
        .limit(1);
      const completed = redemption.qualifyingRidesCompleted + 1;
      const qualified =
        completed >= (code?.qualifyingRides ?? this.qualifyingRides);
      await tx
        .update(referralRedemptions)
        .set({
          qualifyingRidesCompleted: completed,
          qualifyingRideId: qualified ? rideId : redemption.qualifyingRideId,
          status: qualified ? 'QUALIFIED' : 'PENDING',
          qualifiedAt: qualified ? new Date() : redemption.qualifiedAt,
        })
        .where(eq(referralRedemptions.id, redemption.id));
      return qualified;
    };
    return existingTx ? run(existingTx) : this.db.transaction(run);
  }

  private generateCode(): string {
    return randomBytes(Math.ceil(this.codeLength / 2))
      .toString('hex')
      .slice(0, this.codeLength)
      .toUpperCase();
  }

  private viewCode(row: typeof referralCodes.$inferSelect) {
    return {
      code: row.code,
      targetRole: row.targetRole,
      maxRedemptions: row.maxRedemptions,
      redemptionCount: row.redemptionCount,
      validUntil: row.validUntil,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    let current: unknown = err;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if ((current as { code?: string }).code === '23505') return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}
