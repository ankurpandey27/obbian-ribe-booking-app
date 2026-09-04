import { Module } from '@nestjs/common';
import { RidesController } from './rides.controller';
import { RidesService } from './rides.service';
import { FraudService } from './fraud.service';
import { RideStopsService } from './ride-stops.service';
import { ScheduledRidesService } from './scheduled-rides.service';
import { ScheduledRidesWorker } from './workers/scheduled-rides.worker';
import { RideParticipantGuard } from './guards/ride-participant.guard';
import { PricingModule } from '../pricing/pricing.module';
import { PromosModule } from '../promos/promos.module';
import { DriversModule } from '../drivers/drivers.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OpsModule } from '../ops/ops.module';
import { GrowthModule } from '../growth/growth.module';
import { CatalogModule } from '../catalog/catalog.module';

/**
 * Rides �?" the ride lifecycle owner. Future `trip-svc`.
 *
 * Imports LedgerModule because completion credits the driver in the SAME
 * transaction as the COMPLETED transition (ADR-014): a completed ride without
 * its earning entry is unreconcilable.
 */
@Module({
  imports: [
    PricingModule,
    PromosModule,
    DriversModule,
    LedgerModule,
    OpsModule,
    GrowthModule,
    CatalogModule,
  ],
  controllers: [RidesController],
  providers: [
    RidesService,
    FraudService,
    RideStopsService,
    ScheduledRidesService,
    ScheduledRidesWorker,
    RideParticipantGuard,
  ],
  exports: [
    RidesService,
    RideStopsService,
    RideParticipantGuard,
    ScheduledRidesService,
  ],
})
export class RidesModule {}
