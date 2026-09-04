import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Catalog read DTOs (responses) ─────────────────────────────────────────

export class CatalogCategoryDto {
  @ApiProperty({ example: 'CABX' })
  code!: string;

  @ApiProperty({ example: 'Cab AC' })
  displayName!: string;

  @ApiPropertyOptional({ example: 'Air-conditioned cab' })
  description?: string;

  @ApiPropertyOptional()
  iconUrl?: string | null;

  @ApiPropertyOptional()
  thumbnailUrl?: string | null;

  @ApiProperty({ example: 4 })
  capacity!: number;

  @ApiPropertyOptional({ example: { sharedRide: false, womenOnly: false } })
  flags?: Record<string, boolean>;

  @ApiPropertyOptional()
  vehicleClass?: string | null;

  @ApiProperty({ example: true })
  available!: boolean;

  @ApiProperty({ example: 0 })
  sortOrder!: number;
}

export class CatalogServiceDto {
  @ApiProperty({ example: 'RIDE' })
  code!: string;

  @ApiProperty({ example: 'Ride' })
  displayName!: string;

  @ApiPropertyOptional()
  iconUrl?: string | null;

  @ApiProperty({ example: 0 })
  sortOrder!: number;

  @ApiProperty({ type: [CatalogCategoryDto] })
  categories!: CatalogCategoryDto[];
}

export class CatalogResponseDto {
  @ApiProperty({ example: 1 })
  catalogVersion!: number;

  @ApiProperty({ example: 'Hyderabad' })
  city!: string;

  @ApiProperty({ example: 'te-IN' })
  locale!: string;

  @ApiProperty({ type: [CatalogServiceDto] })
  services!: CatalogServiceDto[];
}

// ── Admin: service CRUD DTOs ──────────────────────────────────────────────

export class LocalizedContentDto {
  @ApiProperty({
    example: { 'en-IN': 'Ride', 'hi-IN': 'सवारी', 'te-IN': 'రైడ్' },
  })
  @IsObject()
  enIN!: Record<string, string>;
}

export class CreateServiceDto {
  @ApiProperty({ example: 'RIDE' })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({
    example: { 'en-IN': 'Ride', 'hi-IN': 'सवारी', 'te-IN': 'రైడ్' },
  })
  @IsObject()
  displayName!: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateServiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  displayName?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ── Admin: ride category CRUD DTOs ────────────────────────────────────────

export class CreateRideCategoryDto {
  @ApiProperty({ example: 'CABX' })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty()
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    example: { 'en-IN': 'Cab AC', 'hi-IN': 'कैब एसी', 'te-IN': 'క్యాబ్ ఎసీ' },
  })
  @IsObject()
  displayName!: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  description?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: { sharedRide: false, womenOnly: false } })
  @IsOptional()
  @IsObject()
  flags?: Record<string, boolean>;

  @ApiPropertyOptional({ example: 'CAB' })
  @IsOptional()
  @IsString()
  vehicleClass?: string;

  @ApiPropertyOptional({ example: 1.0 })
  @IsOptional()
  @Type(() => Number)
  etaFactor?: number;
}

export class UpdateRideCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  displayName?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  description?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  flags?: Record<string, boolean>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleClass?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  etaFactor?: number;
}

// ── Admin: city availability DTO ──────────────────────────────────────────

export class SetCategoryCityDto {
  @ApiProperty({ example: 'Hyderabad' })
  @IsString()
  @MaxLength(50)
  city!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  isAvailable!: boolean;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/** Create a ride-category FAQ (admin). */
export class CreateFaqDto {
  @ApiProperty({ example: 'CABX' })
  @IsString()
  @MaxLength(32)
  categoryCode!: string;

  @ApiProperty({
    example: {
      'en-IN': 'How is fare calculated?',
      'hi-IN': 'किराया कैसे होता है?',
      'te-IN': 'ఫీజు ఎలా లెక్కిస్తారు?',
    },
  })
  @IsObject()
  question!: Record<string, string>;

  @ApiProperty({
    example: {
      'en-IN': 'Fare = base + per-km + per-minute, floored at minimum.',
      'hi-IN': 'किराया = बेस + प्रति किमी + प्रति मिनट, न्यूनतम सीमा के साथ।',
      'te-IN': 'ఫీజు = బేస్ + ప్రతి కిమీ + ప్రతి నిమిషం, కనీసం పరిమితితో.',
    },
  })
  @IsObject()
  answer!: Record<string, string>;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/** Update a ride-category FAQ (admin). */
export class UpdateFaqDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  question?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  answer?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
