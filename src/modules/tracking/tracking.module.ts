import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TrackingGateway } from './gateways/tracking.gateway';
import { TrackingService } from './services/tracking.service';
import { TrackingController } from './tracking.controller';
import { Ride } from '../rides/entities/ride.entity';
import { GeoService } from '../../common/redis/geo.service';
import { AuthModule } from '../auth/auth.module';
import { MapsModule } from '../maps/maps.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ride]), AuthModule, MapsModule],
  controllers: [TrackingController],
  providers: [TrackingGateway, TrackingService, GeoService],
  exports: [TrackingService],
})
export class TrackingModule {}
