import { Module } from '@nestjs/common';
import { SharedRideController } from './shared-rides.controller';
import { SharedRideService } from './shared-rides.service';

@Module({
  controllers: [SharedRideController],
  providers: [SharedRideService],
  exports: [SharedRideService],
})
export class SharedRidesModule {}
