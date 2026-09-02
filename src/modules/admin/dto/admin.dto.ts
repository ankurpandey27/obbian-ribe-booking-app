import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RetryDlqDto {
  @ApiProperty({ type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class RetryDlqTypeDto {
  @ApiProperty({ maxLength: 96 })
  @IsString()
  @MinLength(1)
  @MaxLength(96)
  type: string;
}

export class SuspendUserDto {
  @ApiProperty({ enum: ['SUSPENDED', 'BANNED', 'ACTIVE'] })
  @IsEnum(['SUSPENDED', 'BANNED', 'ACTIVE'])
  status: 'SUSPENDED' | 'BANNED' | 'ACTIVE';

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  suspendedUntil?: string;
}

export class RefundDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
