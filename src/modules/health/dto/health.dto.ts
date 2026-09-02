import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DependencyCheckDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'error'] })
  status: 'ok' | 'error';

  @ApiPropertyOptional({ example: 3 })
  latencyMs?: number;

  @ApiPropertyOptional({ example: 'ECONNREFUSED' })
  error?: string;
}

/**
 * Liveness answer. Deliberately carries NO dependency information: the only
 * question is "is this process still able to serve", and the answer must not
 * depend on anything outside the process (see HealthService.liveness).
 */
export class LivenessDto {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status: 'ok';

  @ApiProperty({ example: 4823 })
  uptimeSeconds: number;

  @ApiProperty({ example: '2026-08-09T01:00:00.000Z' })
  timestamp: string;
}

export class HealthDto {
  @ApiProperty({
    example: 'ok',
    enum: ['ok', 'degraded', 'shutting_down'],
    description:
      '`degraded` = a dependency is unreachable. `shutting_down` = the process is draining and must be removed from the load balancer.',
  })
  status: 'ok' | 'degraded' | 'shutting_down';

  @ApiProperty({ example: 4823 })
  uptimeSeconds: number;

  @ApiProperty({ example: '2026-08-09T01:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ type: () => DependencyCheckDto })
  database: DependencyCheckDto;

  @ApiProperty({ type: () => DependencyCheckDto })
  redis: DependencyCheckDto;
}
