import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SettlementService } from './settlement.service';
import { PaymentProcessorWorker } from './workers/payment-processor.worker';
import { RidesModule } from '../rides/rides.module';
import { LedgerModule } from '../ledger/ledger.module';

/**
 * Payments — rider-to-platform money movement plus driver settlement runs.
 *
 * The wallet ledger itself lives in LedgerModule (see the note there): rides
 * and payments both write entries, so keeping it here produced a module cycle.
 */
@Module({
  imports: [RidesModule, LedgerModule],
  controllers: [PaymentsController],
  providers: [
    { provide: 'PAYMENTS_SERVICE', useClass: PaymentsService },
    PaymentsService,
    SettlementService,
    PaymentProcessorWorker,
  ],
  exports: [PaymentsService, SettlementService, 'PAYMENTS_SERVICE'],
})
export class PaymentsModule {}
