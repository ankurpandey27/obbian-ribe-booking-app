import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class RaiseSosDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  rideId?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiProperty({ enum: ['keyword', 'explicit_sos', 'agent_escalation'] })
  @IsIn(['keyword', 'explicit_sos', 'agent_escalation'])
  trigger!: 'keyword' | 'explicit_sos' | 'agent_escalation';

  @ApiPropertyOptional({ example: 17.445 })
  @IsOptional()
  @IsNumber()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 78.377 })
  @IsOptional()
  @IsNumber()
  @IsLongitude()
  lon?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}
