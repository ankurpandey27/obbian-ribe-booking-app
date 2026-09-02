import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { drivers, rides } from '../../common/database/schema';

/**
 * RatingsService — aggregate user/driver ratings from completed rides.
 * Rating values are stored on the ride; this service rolls them up.
 */
@Injectable()
export class RatingsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async getAggregate(userId: string, role: 'RIDER' | 'DRIVER') {
    const rows =
      role === 'RIDER'
        ? await this.db
            .select({ driverRating: rides.driverRating })
            .from(rides)
            .where(eq(rides.riderId, userId))
        : await this.db
            .select({ riderRating: rides.riderRating })
            .from(rides)
            .where(eq(rides.driverId, userId));

    const ratings = rows
      .map((r) => (role === 'RIDER' ? r.driverRating : r.riderRating))
      .filter((r): r is number => r != null);

    const total = ratings.length;
    const average = total ? ratings.reduce((a, b) => a + b, 0) / total : 0;

    const breakdown = [1, 2, 3, 4, 5].map((star) => ({
      star,
      count: ratings.filter((r) => r === star).length,
    }));

    if (role === 'DRIVER') {
      const [driver] = await this.db
        .select()
        .from(drivers)
        .where(eq(drivers.userId, userId))
        .limit(1);
      if (!driver) throw new NotFoundException('Driver not found');
      await this.db
        .update(drivers)
        .set({
          rating: Math.round(average * 100) / 100,
          updatedAt: new Date(),
        })
        .where(eq(drivers.userId, userId));
    }

    return {
      averageRating: Math.round(average * 10) / 10,
      totalReviews: total,
      breakdown,
    };
  }
}
