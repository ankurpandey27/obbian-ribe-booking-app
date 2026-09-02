import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentQuoteRequestDto {
  @ApiProperty({ example: 17.445 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  pickupLat!: number;

  @ApiProperty({ example: 78.377 })
  @IsNumber()
  pickupLon!: number;

  @ApiProperty({ example: 17.44 })
  @IsNumber()
  dropoffLat!: number;

  @ApiProperty({ example: 78.39 })
  @IsNumber()
  dropoffLon!: number;

  @ApiPropertyOptional({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
    default: 'AUTO',
  })
  @IsOptional()
  @IsIn(['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'])
  rideType?: string;

  @ApiPropertyOptional({ example: 'Hyderabad', maxLength: 48 })
  @IsOptional()
  @IsString()
  @MaxLength(48)
  city?: string;
}

export class AgentExecuteRequestDto {
  @ApiProperty({
    enum: ['create_item', 'cancel_item', 'check_status', 'modify_item'],
  })
  @IsIn(['create_item', 'cancel_item', 'check_status', 'modify_item'])
  action!: 'create_item' | 'cancel_item' | 'check_status' | 'modify_item';

  @ApiProperty({ type: Object })
  @IsObject()
  params!: Record<string, unknown>;

  @ApiProperty({ example: 'sha256hex', maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  quoteId?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string;
}

export class AgentQuoteResponseDto {
  @ApiProperty() quoteId!: string;
  @ApiProperty({ description: 'Locked fare in paise' }) farePaise!: number;
  @ApiProperty() surgeMultiplier!: number;
  @ApiPropertyOptional() surgeReason?: string | null;
  @ApiPropertyOptional() etaMinutes?: number;
  @ApiPropertyOptional() distanceKm?: number;
  @ApiProperty() expiresAt!: string;
}

export class AgentExecuteResponseDto {
  @ApiProperty() success!: boolean;
  @ApiPropertyOptional() itemId?: string;
  @ApiProperty({ description: 'Semantic outcome key; agent owns the words' })
  templateKey!: string;
  @ApiPropertyOptional() data?: Record<string, unknown>;
  @ApiPropertyOptional() error?: { code: string; message: string };
}
