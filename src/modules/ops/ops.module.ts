import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CancellationPenaltiesService } from './cancellation-penalties.service';
import { IncidentsService } from './incidents.service';
import { OpsController } from './ops.controller';

@Module({
  imports: [LedgerModule],
  controllers: [OpsController],
  providers: [IncidentsService, CancellationPenaltiesService],
  exports: [IncidentsService, CancellationPenaltiesService],
})
export class OpsModule {}
