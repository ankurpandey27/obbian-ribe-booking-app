import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RidesController } from './controllers/rides.controller';
import { RidesService } from './services/rides.service';
import { FraudService } from './services/fraud.service';
import { ScheduledRidesService } from './services/scheduled-rides.service';
import { ScheduledRidesWorker } from './workers/scheduled-rides.worker';
import { RideParticipantGuard } from './guards/ride-participant.guard';
import { Ride } from './entities/ride.entity';
import { ScheduledRide } from './entities/scheduled-ride.entity';
import { PricingModule } from '../pricing/pricing.module';
import { PromosModule } from '../promos/promos.module';
import { DriversModule } from '../drivers/drivers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride, ScheduledRide]),
    PricingModule,
    PromosModule,
    DriversModule,
  ],
  controllers: [RidesController],
  providers: [
    RidesService,
    FraudService,
    ScheduledRidesService,
    ScheduledRidesWorker,
    RideParticipantGuard,
  ],
  exports: [RidesService, RideParticipantGuard],
})
export class RidesModule {}
