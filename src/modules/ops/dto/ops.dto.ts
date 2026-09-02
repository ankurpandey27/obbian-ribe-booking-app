import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  ArrayMaxSize,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export const INCIDENT_TYPES = [
  'ACCIDENT',
  'HARASSMENT',
  'FRAUD',
  'PROPERTY_DAMAGE',
  'ROUTE_DEVIATION',
  'OVERCHARGE',
  'VEHICLE_MISMATCH',
  'RUDE_BEHAVIOUR',
  'LOST_ITEM',
  'OTHER',
] as const;
export const INCIDENT_SEVERITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
export const INCIDENT_STATUSES = [
  'OPEN',
  'TRIAGED',
  'INVESTIGATING',
  'RESOLVED',
  'DISMISSED',
] as const;

export class CreateIncidentDto {
  @ApiProperty({ enum: INCIDENT_TYPES })
  @IsEnum(INCIDENT_TYPES)
  incidentType: (typeof INCIDENT_TYPES)[number];

  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES, default: 'MEDIUM' })
  @IsOptional()
  @IsEnum(INCIDENT_SEVERITIES)
  severity?: (typeof INCIDENT_SEVERITIES)[number];

  @ApiProperty({ minLength: 5, maxLength: 4000 })
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  rideId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  againstUserId?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  attachmentKeys?: string[];
}

export class AssignIncidentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  assignedToUserId: string;
}

export class ResolveIncidentDto {
  @ApiProperty({ minLength: 3, maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  resolution: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 200000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200000)
  compensationPaise?: number;

  @ApiPropertyOptional({ enum: ['RESOLVED', 'DISMISSED'], default: 'RESOLVED' })
  @IsOptional()
  @IsEnum(['RESOLVED', 'DISMISSED'])
  status?: 'RESOLVED' | 'DISMISSED';
}

export class DisputePenaltyDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

export class IncidentResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() reference: string;
  @ApiPropertyOptional() rideId?: string | null;
  @ApiProperty() reportedByUserId: string;
  @ApiPropertyOptional() againstUserId?: string | null;
  @ApiProperty({ enum: INCIDENT_TYPES }) incidentType: string;
  @ApiProperty({ enum: INCIDENT_SEVERITIES }) severity: string;
  @ApiProperty({ enum: INCIDENT_STATUSES }) status: string;
  @ApiProperty() description: string;
  @ApiPropertyOptional() assignedToUserId?: string | null;
  @ApiPropertyOptional() resolution?: string | null;
  @ApiProperty() compensationPaise: number;
  @ApiProperty() createdAt: string;
  @ApiPropertyOptional() resolvedAt?: string | null;
}

export class PenaltyResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() rideId: string;
  @ApiProperty({ enum: ['RIDER', 'DRIVER'] }) role: string;
  @ApiProperty() offenceIndex: number;
  @ApiProperty() penaltyPaise: number;
  @ApiProperty() isWaived: boolean;
  @ApiProperty() createdAt: string;
}
