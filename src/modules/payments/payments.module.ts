import { Module } from '@nestjs/common';
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsService } from './services/payments.service';
import { SettlementService } from './services/settlement.service';
import { PaymentProcessorWorker } from './workers/payment-processor.worker';
import { RidesModule } from '../rides/rides.module';

@Module({
  imports: [RidesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, SettlementService, PaymentProcessorWorker],
  exports: [PaymentsService],
})
export class PaymentsModule {}
