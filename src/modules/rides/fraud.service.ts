import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, gt, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { rides } from '../../common/database/schema';

@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);
  private readonly enabled: boolean;
  private readonly maxRidesPerHour: number;
  private readonly maxConcurrentActive: number;
  private readonly duplicateWindowMinutes: number;
  private readonly maxDuplicateRequests: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
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
    ]).catch((err: unknown) => {
      // Reject explicit fraud violations — never let them pass silently.
      if (err instanceof ForbiddenException) throw err;
      // Dependency unavailable (Redis/DB down): fail closed. A rider who trips
      // a real limit during an outage is denied rather than allowed through.
      // The request path can decide to retry; the security path does not.
      this.logger.error(
        `fraud guard dependency unavailable for rider=${riderId}: ${String(err)}`,
      );
      throw new ForbiddenException(
        'Unable to verify ride request; please retry shortly',
      );
    });
  }

  private async guardVelocity(riderId: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [row] = await this.db
      .select({ value: count() })
      .from(rides)
      .where(and(eq(rides.riderId, riderId), gt(rides.createdAt, since)));
    if (Number(row?.value ?? 0) >= this.maxRidesPerHour) {
      throw new ForbiddenException(
        `Ride velocity limit reached (${this.maxRidesPerHour}/hour)`,
      );
    }
  }

  private async guardConcurrency(riderId: string): Promise<void> {
    const [row] = await this.db
      .select({ value: count() })
      .from(rides)
      .where(
        and(
          eq(rides.riderId, riderId),
          inArray(rides.status, [
            'REQUESTED',
            'MATCHING',
            'ACCEPTED',
            'ARRIVED',
            'IN_PROGRESS',
          ]),
        ),
      );
    if (Number(row?.value ?? 0) >= this.maxConcurrentActive) {
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
    const requests = Number((await this.redis.get(key)) ?? 0) + 1;
    await this.redis
      .set(key, requests, 'EX', this.duplicateWindowMinutes * 60)
      .catch(() => undefined);
    if (requests > this.maxDuplicateRequests) {
      throw new ForbiddenException(
        `Repeated ride requests from the same location (${requests} in ${this.duplicateWindowMinutes}min)`,
      );
    }
  }
}
