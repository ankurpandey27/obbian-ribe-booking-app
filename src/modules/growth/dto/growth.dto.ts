import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RedeemReferralDto {
  @ApiProperty({ maxLength: 16 })
  @IsString()
  @MinLength(4)
  @MaxLength(16)
  code: string;
}

export class CreateIncentiveDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  driverId: string;

  @ApiProperty({ maxLength: 32 })
  @IsString()
  @MaxLength(32)
  incentiveType: string;

  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MaxLength(160)
  title: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(100000)
  targetRides: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(500000000)
  bonusPaise: number;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  periodStart: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  periodEnd: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  city?: string;
}

export class CreateZoneDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({ maxLength: 96 })
  @IsString()
  @MinLength(2)
  @MaxLength(96)
  slug: string;

  @ApiProperty({
    enum: [
      'CITY_BOUNDARY',
      'AIRPORT',
      'RAILWAY_STATION',
      'RESTRICTED_PICKUP',
      'RESTRICTED_DROPOFF',
      'SURGE_ZONE',
      'DRIVER_QUEUE',
      'TOLL_ZONE',
    ],
  })
  @IsEnum([
    'CITY_BOUNDARY',
    'AIRPORT',
    'RAILWAY_STATION',
    'RESTRICTED_PICKUP',
    'RESTRICTED_DROPOFF',
    'SURGE_ZONE',
    'DRIVER_QUEUE',
    'TOLL_ZONE',
  ])
  areaType: string;

  @ApiProperty({ maxLength: 50 })
  @IsString()
  @MaxLength(50)
  city: string;

  @ApiProperty({ description: 'GeoJSON Polygon object' })
  @IsObject()
  boundary: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  surchargePaise?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 9.99 })
  @IsOptional()
  @IsNumber()
  minSurgeMultiplier?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRestricted?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  restrictionMessage?: string;
}
