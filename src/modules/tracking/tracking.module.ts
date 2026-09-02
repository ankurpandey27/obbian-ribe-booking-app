import { Module } from '@nestjs/common';
import { TrackingGateway } from './gateways/tracking.gateway';
import { TrackingService } from './tracking.service';
import { TrackingController } from './tracking.controller';
import { AuthModule } from '../auth/auth.module';
import { MapsModule } from '../maps/maps.module';
import { RidesModule } from '../rides/rides.module';

/** Live tracking. Future `tracking-svc`. GeoService comes from RedisModule. */
@Module({
  imports: [AuthModule, MapsModule, RidesModule],
  controllers: [TrackingController],
  providers: [TrackingGateway, TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
