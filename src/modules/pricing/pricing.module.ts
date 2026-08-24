import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PricingService } from './services/pricing.service';
import { SurgeService } from './services/surge.service';
import { MapsModule } from '../maps/maps.module';

@Module({
  imports: [MapsModule],
  controllers: [PricingController],
  providers: [PricingService, SurgeService],
  exports: [PricingService, SurgeService],
})
export class PricingModule {}
