import { Module } from '@nestjs/common';
import { MatchingService } from './services/matching.service';
import { MatchingWorker } from './services/matching.worker';
import { DriverRideActionsController } from './controllers/driver-ride-actions.controller';
import { DriversModule } from '../drivers/drivers.module';
import { RidesModule } from '../rides/rides.module';
import { GeoService } from '../../common/redis/geo.service';

@Module({
  imports: [DriversModule, RidesModule],
  controllers: [DriverRideActionsController],
  providers: [MatchingService, MatchingWorker, GeoService],
  exports: [MatchingService],
})
export class MatchingModule {}
