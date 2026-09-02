import { Module } from '@nestjs/common';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';
import { SurgeService } from './surge.service';
import { FareBreakdownService } from './fare-breakdown.service';
import { InvoiceService } from './invoice.service';
import { MapsModule } from '../maps/maps.module';
import { GrowthModule } from '../growth/growth.module';

/**
 * Pricing + billing artefacts. Future `pricing-svc` seam.
 *
 * FareBreakdownService and InvoiceService are exported because RidesService
 * writes both at completion, inside the same transaction as the COMPLETED
 * transition (ADR-014) �?" a ride cannot be completed without its receipt.
 */
@Module({
  imports: [MapsModule, GrowthModule],
  controllers: [PricingController],
  providers: [
    PricingService,
    SurgeService,
    FareBreakdownService,
    InvoiceService,
  ],
  exports: [PricingService, SurgeService, FareBreakdownService, InvoiceService],
})
export class PricingModule {}
