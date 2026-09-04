import { Module } from '@nestjs/common';
import { RouteOptimizationService } from './route-optimization.service';
import { MapsModule } from '../maps/maps.module';

@Module({
  imports: [MapsModule],
  providers: [RouteOptimizationService],
  exports: [RouteOptimizationService],
})
export class RouteOptimizationModule {}
