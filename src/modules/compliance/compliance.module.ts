import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { DriverDocumentsService } from './driver-documents.service';
import { DriverVehiclesService } from './driver-vehicles.service';
import { ComplianceExpirySweepService } from './compliance-expiry.service';

/**
 * Driver compliance — the regulatory dispatch gate. Future `user-svc`
 * (onboarding slice) after extraction.
 *
 * Exports DriverDocumentsService because DriversModule needs
 * `recomputeEligibility` / eligibility reads to refuse an ONLINE transition for
 * a non-compliant driver (ADR-013). Nothing outside this module writes
 * `driver_documents` or `driver_vehicles`.
 */
@Module({
  controllers: [ComplianceController],
  providers: [
    DriverDocumentsService,
    DriverVehiclesService,
    ComplianceExpirySweepService,
  ],
  exports: [DriverDocumentsService, DriverVehiclesService],
})
export class ComplianceModule {}
