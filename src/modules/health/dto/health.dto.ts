import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DependencyCheckDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiPropertyOptional({ example: 3 })
  latencyMs?: number;

  @ApiPropertyOptional({ example: 'ECONNREFUSED' })
  error?: string;
}

export class HealthDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] })
  status: 'ok' | 'degraded';

  @ApiProperty({ example: 4823 })
  uptimeSeconds: number;

  @ApiProperty({ example: '2026-08-09T01:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ type: () => DependencyCheckDto })
  database: DependencyCheckDto;

  @ApiProperty({ type: () => DependencyCheckDto })
  redis: DependencyCheckDto;
}
