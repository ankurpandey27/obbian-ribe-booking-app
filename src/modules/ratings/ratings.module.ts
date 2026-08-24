import { Module } from '@nestjs/common';
import { RatingsController } from './controllers/ratings.controller';
import { RatingsService } from './services/ratings.service';
import { User } from '../users/entities/user.entity';
import { Driver } from '../drivers/entities/driver.entity';
import { Ride } from '../rides/entities/ride.entity';

@Module({
  imports: [],
  controllers: [RatingsController],
  providers: [RatingsService],
  exports: [RatingsService],
})
export class RatingsModule {}
