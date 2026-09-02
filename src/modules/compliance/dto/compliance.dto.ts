import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DocumentStatusValue,
  DriverDocumentTypeValue,
  RideTypeValue,
} from '../../../shared/types/common';

const DOCUMENT_TYPES = [
  'DRIVING_LICENSE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_INSURANCE',
  'VEHICLE_FITNESS',
  'VEHICLE_PERMIT',
  'POLLUTION_CERTIFICATE',
  'AADHAAR',
  'PAN',
  'PROFILE_PHOTO',
  'BANK_PROOF',
] as const;

const VEHICLE_TYPES = [
  'CABX_SAVER',
  'CABX',
  'CABXL',
  'COMFORT',
  'AUTO',
  'TWO_WHEELER',
] as const;

/* ------------------------------ requests ------------------------------ */

export class SubmitDocumentDto {
  @ApiProperty({ enum: DOCUMENT_TYPES, example: 'DRIVING_LICENSE' })
  @IsEnum(DOCUMENT_TYPES)
  documentType: DriverDocumentTypeValue;

  @ApiProperty({
    example: 'drivers/b0e2a3f4/driving_license/1724668800.jpg',
    description:
      'Object-store key returned by the upload flow. Never a public URL — ' +
      'reads are signed on demand.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  storageKey: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000000',
    description:
      'Required for vehicle-scoped documents (RC, insurance, fitness, ' +
      'permit, PUC). Omit for person-scoped documents.',
  })
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional({ example: 'DL-0420110012345' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  documentNumber?: string;

  @ApiPropertyOptional({ example: '2022-04-01' })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({
    example: '2032-03-31',
    description:
      'Omit only for documents that genuinely never expire (PAN, Aadhaar). ' +
      'Required documents without an expiry cannot be swept for renewal.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class VerifyDocumentDto {
  @ApiProperty({
    example: true,
    description: 'true = VERIFIED, false = REJECTED (reason then required).',
  })
  @IsBoolean()
  approved: boolean;

  @ApiPropertyOptional({
    example: 'Licence photo is blurred; upload a clearer scan.',
    description:
      'Required when approved=false — a rejection the driver cannot act on ' +
      'is a dead end (also enforced by a DB CHECK).',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  rejectionReason?: string;

  @ApiPropertyOptional({
    example: '2032-03-31',
    description:
      'Lets the reviewer correct the expiry read off the document itself.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class AddVehicleDto {
  @ApiProperty({ example: 'TS09AB1234' })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  registrationNumber: string;

  @ApiProperty({ enum: VEHICLE_TYPES, example: 'AUTO' })
  @IsEnum(VEHICLE_TYPES)
  vehicleType: RideTypeValue;

  @ApiPropertyOptional({ example: 'Bajaj' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  make?: string;

  @ApiPropertyOptional({ example: 'RE Compact' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  model?: string;

  @ApiPropertyOptional({ example: 'Yellow' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({ example: 2021 })
  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(2100)
  manufactureYear?: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  seatingCapacity?: number;
}

export class SetActiveVehicleDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000000' })
  @IsUUID()
  vehicleId: string;
}

/* ------------------------------ responses ------------------------------ */

export class DriverDocumentDto {
  @ApiProperty({ example: 'd1e2f3a4-0000-0000-0000-000000000000' })
  id: string;

  @ApiProperty({ enum: DOCUMENT_TYPES })
  documentType: DriverDocumentTypeValue;

  @ApiProperty({
    enum: ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'],
  })
  status: DocumentStatusValue;

  @ApiPropertyOptional({ example: 'a1b2c3d4-0000-0000-0000-000000000000' })
  vehicleId?: string;

  @ApiPropertyOptional({ example: 'DL-0420110012345' })
  documentNumber?: string;

  @ApiPropertyOptional({ example: '2032-03-31T00:00:00.000Z' })
  expiresAt?: string;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Days until expiry. Negative means already lapsed. Absent when the ' +
      'document has no expiry.',
  })
  daysUntilExpiry?: number;

  @ApiPropertyOptional({ example: 'Licence photo is blurred.' })
  rejectionReason?: string;

  @ApiProperty({ example: 1, description: 'Uploads against this slot so far.' })
  submissionCount: number;

  @ApiProperty({ example: '2026-08-26T09:15:00.000Z' })
  createdAt: string;
}

export class DriverVehicleResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000000' })
  id: string;

  @ApiProperty({ example: 'TS09AB1234' })
  registrationNumber: string;

  @ApiProperty({ enum: VEHICLE_TYPES })
  vehicleType: RideTypeValue;

  @ApiPropertyOptional({ example: 'Bajaj' })
  make?: string;

  @ApiPropertyOptional({ example: 'RE Compact' })
  model?: string;

  @ApiPropertyOptional({ example: 'Yellow' })
  color?: string;

  @ApiProperty({
    example: false,
    description: 'All vehicle-scoped documents VERIFIED and unexpired.',
  })
  isVerified: boolean;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({
    example: true,
    description: 'This is the vehicle currently in service for dispatch.',
  })
  isCurrentlyAssigned: boolean;

  @ApiPropertyOptional({ example: '2027-01-31T00:00:00.000Z' })
  insuranceExpiresAt?: string;
}

export class ComplianceStatusDto {
  @ApiProperty({
    example: false,
    description:
      'Dispatch eligibility. false blocks going ONLINE and excludes the ' +
      'driver from matching.',
  })
  isComplianceVerified: boolean;

  @ApiProperty({
    example: ['VEHICLE_INSURANCE'],
    description: 'Required slots that are missing, unverified or expired.',
    isArray: true,
    enum: DOCUMENT_TYPES,
  })
  missingDocuments: DriverDocumentTypeValue[];

  @ApiProperty({
    example: ['DRIVING_LICENSE'],
    description:
      'Verified documents lapsing inside the warning window — renew before ' +
      'dispatch eligibility is lost.',
    isArray: true,
    enum: DOCUMENT_TYPES,
  })
  expiringSoon: DriverDocumentTypeValue[];

  @ApiProperty({ type: [DriverDocumentDto] })
  documents: DriverDocumentDto[];

  @ApiPropertyOptional({ example: '2026-08-26T02:30:00.000Z' })
  lastCheckedAt?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000000',
    description: 'Vehicle currently in service, if any.',
  })
  activeVehicleId?: string;
}

export class ComplianceActionResultDto {
  @ApiProperty({ example: true })
  updated: boolean;

  @ApiProperty({
    example: false,
    description: 'Dispatch eligibility AFTER this action.',
  })
  isComplianceVerified: boolean;

  @ApiProperty({
    example: ['VEHICLE_INSURANCE'],
    isArray: true,
    enum: DOCUMENT_TYPES,
  })
  missingDocuments: DriverDocumentTypeValue[];
}

export class DocumentReviewQueueItemDto extends DriverDocumentDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  driverId: string;

  @ApiPropertyOptional({ example: 'TS09AB1234' })
  vehicleRegistration?: string;
}
