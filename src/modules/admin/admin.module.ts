import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { PricingModule } from '../pricing/pricing.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    CommonModule,
    ComplianceModule,
    LedgerModule,
    PaymentsModule,
    PricingModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
