import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Promo } from '../entities/promo.entity';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';

/**
 * PromosService — simple DB-backed promo validation (no engine).
 * Discount capped at maxDiscount; per-user usage capped via Redis counter.
 */
@Injectable()
export class PromosService {
  constructor(
    @InjectRepository(Promo) private readonly promoRepo: Repository<Promo>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async validate(code: string, userId: string) {
    const promo = await this.promoRepo.findOneBy({
      code: code.toUpperCase(),
      isActive: true,
    });
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

  async markUsed(code: string, userId: string) {
    const promo = await this.promoRepo.findOneBy({ code: code.toUpperCase() });
    if (!promo) return;
    const usageKey = `promo:${promo.id}:user:${userId}`;
    await this.redis.incr(usageKey);
    await this.redis.expire(usageKey, 60 * 60 * 24 * 90);
  }

  async listAvailable() {
    const promos = await this.promoRepo.find({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    return promos.map((p) => ({
      code: p.code,
      discountPercent: Number(p.discountPercent),
      maxDiscount: Number(p.maxDiscount),
      validUntil: p.validUntil,
    }));
  }
}
