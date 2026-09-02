import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DriverIncentivesService } from './driver-incentives.service';
import { GrowthController } from './growth.controller';
import { ReferralsService } from './referrals.service';
import { ZonesService } from './zones.service';

@Module({
  imports: [LedgerModule],
  controllers: [GrowthController],
  providers: [ReferralsService, DriverIncentivesService, ZonesService],
  exports: [ReferralsService, DriverIncentivesService, ZonesService],
})
export class GrowthModule {}
