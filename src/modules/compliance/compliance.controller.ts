import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/decorators';
import { JwtPayload } from '../auth/token.service';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';
import {
  AddVehicleDto,
  ComplianceActionResultDto,
  ComplianceStatusDto,
  DocumentReviewQueueItemDto,
  DriverDocumentDto,
  DriverVehicleResponseDto,
  SetActiveVehicleDto,
  SubmitDocumentDto,
  VerifyDocumentDto,
} from './dto/compliance.dto';
import {
  DocumentRow,
  DriverDocumentsService,
} from './driver-documents.service';
import { DriverVehiclesService, VehicleRow } from './driver-vehicles.service';
import { DriverDocumentTypeValue } from '../../shared/types/common';

@ApiTags('compliance')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@ApiBadRequestResponse({
  type: ApiEnvelopeDto,
  description: 'Validation failed',
})
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly documents: DriverDocumentsService,
    private readonly vehicles: DriverVehiclesService,
  ) {}

  /* ------------------------------ driver ------------------------------ */

  @Get('me')
  @Roles('DRIVER')
  @ApiOperation({
    summary: 'Own compliance status — what is blocking going ONLINE',
  })
  @ApiOkResponse({ type: ComplianceStatusDto })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Driver not found',
  })
  async getMyStatus(
    @CurrentUser() user: JwtPayload,
  ): Promise<ComplianceStatusDto> {
    const status = await this.documents.getComplianceStatus(user.sub);
    return {
      isComplianceVerified: status.isComplianceVerified,
      missingDocuments: status.missingDocuments,
      expiringSoon: status.expiringSoon,
      documents: status.documents.map((d) => this.serializeDocument(d)),
      lastCheckedAt: status.lastCheckedAt?.toISOString(),
      activeVehicleId: status.activeVehicleId ?? undefined,
    };
  }

  @Post('documents')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit or re-upload a document for review',
    description:
      'Re-submitting supersedes a PENDING/IN_REVIEW document in the same slot. ' +
      'A VERIFIED slot cannot be overwritten without support.',
  })
  @ApiCreatedResponse({ type: ComplianceActionResultDto })
  @ApiConflictResponse({
    type: ApiEnvelopeDto,
    description: 'Slot already verified, or a concurrent submission won',
  })
  async submitDocument(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SubmitDocumentDto,
  ): Promise<ComplianceActionResultDto> {
    const { evaluation } = await this.documents.submit(user.sub, dto);
    return this.serializeAction(evaluation);
  }

  @Get('vehicles')
  @Roles('DRIVER')
  @ApiOperation({ summary: 'Own vehicles, active first' })
  @ApiOkResponse({ type: [DriverVehicleResponseDto] })
  async listMyVehicles(
    @CurrentUser() user: JwtPayload,
  ): Promise<DriverVehicleResponseDto[]> {
    const [vehicles, status] = await Promise.all([
      this.vehicles.listForDriver(user.sub),
      this.documents.getComplianceStatus(user.sub),
    ]);
    return vehicles.map((v) =>
      this.serializeVehicle(v, status.activeVehicleId ?? null),
    );
  }

  @Post('vehicles')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a vehicle',
    description:
      'The first vehicle added becomes the active one. Registration numbers ' +
      'are normalised to uppercase alphanumerics and are globally unique.',
  })
  @ApiCreatedResponse({ type: DriverVehicleResponseDto })
  @ApiConflictResponse({
    type: ApiEnvelopeDto,
    description: 'Registration already on another account',
  })
  async addVehicle(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddVehicleDto,
  ): Promise<DriverVehicleResponseDto> {
    const vehicle = await this.vehicles.add(user.sub, dto);
    return this.serializeVehicle(vehicle, vehicle.id);
  }

  @Put('vehicles/active')
  @Roles('DRIVER')
  @ApiOperation({
    summary: 'Switch the vehicle in service',
    description:
      'Compliance is re-evaluated against the new vehicle — switching to one ' +
      'without verified RC/insurance stops dispatch immediately.',
  })
  @ApiOkResponse({ type: DriverVehicleResponseDto })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Vehicle not found',
  })
  async setActiveVehicle(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetActiveVehicleDto,
  ): Promise<DriverVehicleResponseDto> {
    const vehicle = await this.vehicles.setActive(user.sub, dto.vehicleId);
    return this.serializeVehicle(vehicle, vehicle.id);
  }

  @Delete('vehicles/:vehicleId')
  @Roles('DRIVER')
  @ApiOperation({
    summary: 'Retire a vehicle (soft delete — ride history is preserved)',
  })
  @ApiOkResponse({ type: DriverVehicleResponseDto })
  @ApiParam({ name: 'vehicleId', format: 'uuid' })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Active vehicle not found for this driver',
  })
  async retireVehicle(
    @CurrentUser() user: JwtPayload,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
  ): Promise<DriverVehicleResponseDto> {
    const vehicle = await this.vehicles.retire(user.sub, vehicleId);
    return this.serializeVehicle(vehicle, null);
  }

  /* ------------------------------- admin ------------------------------- */

  @Get('review-queue')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Documents awaiting review, oldest first' })
  @ApiOkResponse({ type: [DocumentReviewQueueItemDto] })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  async listReviewQueue(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<DocumentReviewQueueItemDto[]> {
    const rows = await this.documents.listReviewQueue(
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
    return rows.map((r) => ({
      ...this.serializeDocument(r),
      driverId: r.driverId,
      vehicleRegistration: r.vehicleRegistration ?? undefined,
    }));
  }

  @Put('documents/:documentId/review')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Approve or reject a submitted document',
    description:
      'Approving may grant dispatch eligibility. Rejecting requires a reason ' +
      'and frees the slot for re-upload.',
  })
  @ApiOkResponse({ type: ComplianceActionResultDto })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Document not found',
  })
  @ApiConflictResponse({
    type: ApiEnvelopeDto,
    description: 'Already reviewed, or reviewed concurrently',
  })
  async reviewDocument(
    @CurrentUser() user: JwtPayload,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: VerifyDocumentDto,
  ): Promise<ComplianceActionResultDto> {
    const { evaluation } = await this.documents.review(
      documentId,
      user.sub,
      dto,
    );
    return this.serializeAction(evaluation);
  }

  @Get('drivers/:driverId')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Compliance status for any driver' })
  @ApiOkResponse({ type: ComplianceStatusDto })
  @ApiParam({ name: 'driverId', format: 'uuid' })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Driver not found',
  })
  async getDriverStatus(
    @Param('driverId', ParseUUIDPipe) driverId: string,
  ): Promise<ComplianceStatusDto> {
    const status = await this.documents.getComplianceStatus(driverId);
    return {
      isComplianceVerified: status.isComplianceVerified,
      missingDocuments: status.missingDocuments,
      expiringSoon: status.expiringSoon,
      documents: status.documents.map((d) => this.serializeDocument(d)),
      lastCheckedAt: status.lastCheckedAt?.toISOString(),
      activeVehicleId: status.activeVehicleId ?? undefined,
    };
  }

  /* ---------------------------- serialisers ---------------------------- */

  /**
   * Response shaping. `storageKey` is deliberately NOT exposed: it is an
   * object-store path, and reads must go through a signed-URL flow rather than
   * letting a client construct one.
   */
  private serializeDocument(doc: DocumentRow): DriverDocumentDto {
    const daysUntilExpiry = doc.expiresAt
      ? Math.ceil((doc.expiresAt.getTime() - Date.now()) / 86_400_000)
      : undefined;
    return {
      id: doc.id,
      documentType: doc.documentType,
      status: doc.status,
      vehicleId: doc.vehicleId ?? undefined,
      documentNumber: doc.documentNumber ?? undefined,
      expiresAt: doc.expiresAt?.toISOString(),
      daysUntilExpiry,
      rejectionReason: doc.rejectionReason ?? undefined,
      submissionCount: doc.submissionCount,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  private serializeVehicle(
    vehicle: VehicleRow,
    activeVehicleId: string | null,
  ): DriverVehicleResponseDto {
    return {
      id: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      vehicleType: vehicle.vehicleType,
      make: vehicle.make ?? undefined,
      model: vehicle.model ?? undefined,
      color: vehicle.color ?? undefined,
      isVerified: vehicle.isVerified,
      isActive: vehicle.isActive,
      isCurrentlyAssigned: vehicle.id === activeVehicleId,
      insuranceExpiresAt: vehicle.insuranceExpiresAt?.toISOString(),
    };
  }

  private serializeAction(evaluation: {
    isComplianceVerified: boolean;
    missingDocuments: DriverDocumentTypeValue[];
  }): ComplianceActionResultDto {
    return {
      updated: true,
      isComplianceVerified: evaluation.isComplianceVerified,
      missingDocuments: evaluation.missingDocuments,
    };
  }
}
