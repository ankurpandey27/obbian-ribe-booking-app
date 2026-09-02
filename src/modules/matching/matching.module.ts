import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingWorker } from './workers/matching.worker';
import { RideClaimCoordinator } from './ride-claim.coordinator';
import { DriverRideActionsController } from './driver-ride-actions.controller';
import { DriversModule } from '../drivers/drivers.module';
import { RidesModule } from '../rides/rides.module';

/**
 * Dispatch engine. Future `matching-svc`. GeoService comes from RedisModule.
 *
 * RideClaimCoordinator owns the atomic claim plus its pub/sub wake-up, keeping
 * MatchingService focused on candidate selection and offer flow (ADR-015).
 */
@Module({
  imports: [DriversModule, RidesModule],
  controllers: [DriverRideActionsController],
  providers: [MatchingService, MatchingWorker, RideClaimCoordinator],
  exports: [MatchingService],
})
export class MatchingModule {}
