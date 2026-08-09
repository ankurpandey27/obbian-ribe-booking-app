import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PricingController } from './pricing.controller';
import { PricingService } from './services/pricing.service';
import { SurgeService } from './services/surge.service';
import { FareConfig } from './entities/fare-config.entity';
import { Driver } from '../drivers/entities/driver.entity';
import { MapsModule } from '../maps/maps.module';

@Module({
  imports: [TypeOrmModule.forFeature([FareConfig, Driver]), MapsModule],
  controllers: [PricingController],
  providers: [PricingService, SurgeService],
  exports: [PricingService, SurgeService],
})
export class PricingModule {}
