import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Driver } from '../../drivers/entities/driver.entity';
import { Ride } from '../../rides/entities/ride.entity';

/**
 * RatingsService — aggregate user/driver ratings from completed rides.
 * Rating values are stored on the ride; this service rolls them up.
 */
@Injectable()
export class RatingsService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(Driver) private readonly driverRepo: Repository<Driver>,
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
  ) {}

  async getAggregate(userId: string, role: 'RIDER' | 'DRIVER') {
    const rides =
      role === 'RIDER'
        ? await this.rideRepo.findBy({ riderId: userId })
        : await this.rideRepo.findBy({ driverId: userId });

    const ratings = rides
      .map((r) => (role === 'RIDER' ? r.driverRating : r.riderRating))
      .filter((r): r is number => r != null);

    const total = ratings.length;
    const average = total ? ratings.reduce((a, b) => a + b, 0) / total : 0;

    const breakdown = [1, 2, 3, 4, 5].map((star) => ({
      star,
      count: ratings.filter((r) => r === star).length,
    }));

    if (role === 'DRIVER') {
      const driver = await this.driverRepo.findOneBy({ userId });
      if (!driver) throw new NotFoundException('Driver not found');
      await this.driverRepo.update(userId, { rating: average });
    }

    return {
      averageRating: Math.round(average * 10) / 10,
      totalReviews: total,
      breakdown,
    };
  }
}
