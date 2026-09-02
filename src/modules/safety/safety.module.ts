import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';

/** SOS intake + durable safety events (ADR-00X). */
@Module({
  controllers: [SafetyController],
  providers: [SafetyService],
})
export class SafetyModule {}
