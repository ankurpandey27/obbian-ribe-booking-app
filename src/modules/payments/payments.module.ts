import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsController } from './controllers/payments.controller';
import { PaymentsService } from './services/payments.service';
import { SettlementService } from './services/settlement.service';
import { PaymentProcessorWorker } from './workers/payment-processor.worker';
import { Payment } from './entities/payment.entity';
import { Ride } from '../rides/entities/ride.entity';
import { Driver } from '../drivers/entities/driver.entity';
import { RidesModule } from '../rides/rides.module';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, Ride, Driver]), RidesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, SettlementService, PaymentProcessorWorker],
  exports: [PaymentsService],
})
export class PaymentsModule {}
