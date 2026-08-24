import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../../common/database/drizzle.module';
import { promos } from '../../../common/database/schema';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';

/**
 * PromosService — DB-backed promo validation (no engine).
 * Discount capped at maxDiscount; per-user usage claimed atomically via
 * Redis INCR (see redeem). Reads go through Drizzle.
 */
@Injectable()
export class PromosService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async findActiveByCode(code: string) {
    const [promo] = await this.db
      .select()
      .from(promos)
      .where(and(eq(promos.code, code.toUpperCase()), eq(promos.isActive, true)))
      .limit(1);
    return promo;
  }

  async validate(code: string, userId: string) {
    const promo = await this.findActiveByCode(code);
    if (!promo) throw new NotFoundException('Invalid promo code');

    const now = new Date();
    if (promo.validFrom && now < promo.validFrom) {
      throw new BadRequestException('Promo not yet active');
    }
    if (promo.validUntil && now > promo.validUntil) {
      throw new BadRequestException('Promo expired');
    }

    const usageKey = `promo:${promo.id}:user:${userId}`;
    const usage = Number((await this.redis.get(usageKey)) ?? 0);
    if (usage >= promo.maxUsesPerUser) {
      throw new BadRequestException('Promo usage limit reached');
    }

    return {
      code: promo.code,
      discountPercent: Number(promo.discountPercent),
      maxDiscount: Number(promo.maxDiscount),
      validUntil: promo.validUntil,
    };
  }

  /**
   * Atomically claim one use of a promo for a user.
   * Redis INCR is single-threaded-atomic, so two concurrent ride requests
   * can never both consume the last permitted use (the old
   * validate-then-markUsed pair allowed exactly that race).
   * Throws when the per-user cap is already exhausted.
   */
  async redeem(code: string, userId: string) {
    const promo = await this.findActiveByCode(code);
    if (!promo) throw new NotFoundException('Invalid promo code');

    const now = new Date();
    if (promo.validFrom && now < promo.validFrom) {
      throw new BadRequestException('Promo not yet active');
    }
    if (promo.validUntil && now > promo.validUntil) {
      throw new BadRequestException('Promo expired');
    }

    const usageKey = `promo:${promo.id}:user:${userId}`;
    const uses = await this.redis.incr(usageKey);
    if (uses === 1) {
      // Fixed 90-day window from first use; later INCRs must not extend it.
      await this.redis.expire(usageKey, 60 * 60 * 24 * 90);
    }
    if (uses > promo.maxUsesPerUser) {
      await this.redis.decr(usageKey);
      throw new BadRequestException('Promo usage limit reached');
    }

    return {
      code: promo.code,
      discountPercent: Number(promo.discountPercent),
      maxDiscount: Number(promo.maxDiscount),
      validUntil: promo.validUntil,
    };
  }

  /**
   * Compensation for a failed ride creation after a successful redeem().
   * Best effort — a lost decrement only under-counts usage, never over.
   */
  async release(code: string, userId: string): Promise<void> {
    try {
      const [promo] = await this.db
        .select()
        .from(promos)
        .where(eq(promos.code, code.toUpperCase()))
        .limit(1);
      if (!promo) return;
      await this.redis.decr(`promo:${promo.id}:user:${userId}`);
    } catch {
      // Intentionally swallowed — see doc above.
    }
  }

  async listAvailable() {
    const rows = await this.db
      .select()
      .from(promos)
      .where(eq(promos.isActive, true))
      .orderBy(desc(promos.createdAt))
      .limit(10);
    return rows.map((p) => ({
      code: p.code,
      discountPercent: Number(p.discountPercent),
      maxDiscount: Number(p.maxDiscount),
      validUntil: p.validUntil,
    }));
  }
}
