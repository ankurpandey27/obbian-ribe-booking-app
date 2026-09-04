import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';
import { StubEmergencyProvider } from './emergency.provider';

/** SOS intake + durable safety events (ADR-00X). */
@Module({
  controllers: [SafetyController],
  providers: [
    SafetyService,
    { provide: 'EMERGENCY_PROVIDER', useClass: StubEmergencyProvider },
  ],
})
export class SafetyModule {}
