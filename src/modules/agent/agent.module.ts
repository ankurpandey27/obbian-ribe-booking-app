import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentRidesService } from './agent-rides.service';
import { RideEventForwarderWorker } from './workers/ride-event-forwarder.worker';
import { PricingModule } from '../pricing/pricing.module';
import { RidesModule } from '../rides/rides.module';
import { TrackingModule } from '../tracking/tracking.module';
import { DriversModule } from '../drivers/drivers.module';
import { UsersModule } from '../users/users.module';

/**
 * Roju agent surface (ADR-00X). Cross-module READS ride the exported
 * services of pricing/rides/tracking; writes stay inside their owning
 * services so every fraud guard, price lock and state-machine rule holds.
 */
@Module({
  imports: [
    PricingModule,
    RidesModule,
    TrackingModule,
    DriversModule,
    UsersModule,
  ],
  controllers: [AgentController],
  providers: [AgentRidesService, RideEventForwarderWorker],
})
export class AgentModule {}
