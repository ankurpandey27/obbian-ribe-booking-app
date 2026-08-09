import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, In } from 'typeorm';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { Ride } from '../entities/ride.entity';

/**
 * FraudService — ride-request guards. Cheap DB + Redis checks that
 * reject abusive patterns before a driver is ever dispatched:
 *  1. Velocity: rides started per hour (hard cap).
 *  2. Concurrency: too many active rides at once (double-booking abuse).
 *  3. Duplicate pickup: same coordinates requested N times in a window
 *     (typical of promo farming / auto-refresh bots).
 * Config-gated; best effort, fails open on Redis errors.
 */
@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);
  private readonly enabled: boolean;
  private readonly maxRidesPerHour: number;
  private readonly maxConcurrentActive: number;
  private readonly duplicateWindowMinutes: number;
  private readonly maxDuplicateRequests: number;

  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    @InjectRedis() private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('fraud.enabled', true);
    this.maxRidesPerHour = config.get<number>('fraud.maxRidesPerHour', 5);
    this.maxConcurrentActive = config.get<number>(
      'fraud.maxConcurrentActiveRides',
      2,
    );
    this.duplicateWindowMinutes = config.get<number>(
      'fraud.duplicateWindowMinutes',
      10,
    );
    this.maxDuplicateRequests = config.get<number>(
      'fraud.maxDuplicateRequests',
      3,
    );
  }

  /** Run all guards; throws ForbiddenException when a rule trips. */
  async guardRideRequest(
    riderId: string,
    pickupLat: number,
    pickupLon: number,
    city: string,
  ): Promise<void> {
    if (!this.enabled) return;

    await Promise.all([
      this.guardVelocity(riderId),
      this.guardConcurrency(riderId),
      this.guardDuplicatePickup(riderId, pickupLat, pickupLon, city),
    ]).catch((err) => {
      if (err instanceof ForbiddenException) throw err;
      // Redis hiccup → fail open, never block genuine riders.
      this.logger.warn(`fraud guard skipped: ${err.message}`);
    });
  }

  private async guardVelocity(riderId: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.rideRepo.count({
      where: { riderId, createdAt: MoreThan(since) },
    });
    if (count >= this.maxRidesPerHour) {
      throw new ForbiddenException(
        `Ride velocity limit reached (${this.maxRidesPerHour}/hour)`,
      );
    }
  }

  private async guardConcurrency(riderId: string): Promise<void> {
    const active = await this.rideRepo.count({
      where: {
        riderId,
        status: In([
          'REQUESTED',
          'MATCHING',
          'ACCEPTED',
          'ARRIVED',
          'IN_PROGRESS',
        ]),
      },
    });
    if (active >= this.maxConcurrentActive) {
      throw new ForbiddenException(
        `Too many active rides (max ${this.maxConcurrentActive})`,
      );
    }
  }

  private async guardDuplicatePickup(
    riderId: string,
    pickupLat: number,
    pickupLon: number,
    city: string,
  ): Promise<void> {
    const key = `fraud:dup:${riderId}:${pickupLat.toFixed(4)},${pickupLon.toFixed(4)}:${city}`;
    const count = Number((await this.redis.get(key)) ?? 0) + 1;
    await this.redis
      .set(key, count, 'EX', this.duplicateWindowMinutes * 60)
      .catch(() => undefined);
    if (count > this.maxDuplicateRequests) {
      throw new ForbiddenException(
        `Repeated ride requests from the same location (${count} in ${this.duplicateWindowMinutes}min)`,
      );
    }
  }
}
