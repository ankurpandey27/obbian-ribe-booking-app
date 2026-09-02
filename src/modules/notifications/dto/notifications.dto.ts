import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @MaxLength(128)
  deviceId: string;

  @ApiProperty({ enum: ['ANDROID', 'IOS', 'WEB'] })
  @IsEnum(['ANDROID', 'IOS', 'WEB'])
  platform: 'ANDROID' | 'IOS' | 'WEB';

  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  pushToken?: string;

  @ApiPropertyOptional({ maxLength: 24 })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  appVersion?: string;

  @ApiPropertyOptional({ maxLength: 24 })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  osVersion?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceModel?: string;

  @ApiPropertyOptional({ maxLength: 12 })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  locale?: string;
}

export class NotificationPreferencesDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;
}
