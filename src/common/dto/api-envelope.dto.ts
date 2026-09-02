import { ApiProperty } from '@nestjs/swagger';

/** Structured error detail carried inside the unified envelope. */
export class ApiErrorDetailDto {
  @ApiProperty({ example: 'NOT_FOUND' })
  code!: string;

  @ApiProperty({ example: 'Ride not found' })
  message!: string | string[];

  @ApiProperty({ required: false })
  details?: unknown;
}

/**
 * Unified response envelope for every HTTP endpoint (success and error).
 * Controllers return the raw payload; a global interceptor + exception filter
 * shape it into this contract.
 */
export class ApiEnvelopeDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'User profile fetched' })
  message!: string;

  @ApiProperty({ example: 200 })
  messageCode!: number;

  @ApiProperty({ nullable: true })
  data!: unknown;

  @ApiProperty({ nullable: true, type: ApiErrorDetailDto })
  error!: ApiErrorDetailDto | null;

  @ApiProperty({ example: '/api/v1/rides/request' })
  path!: string;

  @ApiProperty({ example: 'req_uuid' })
  requestId!: string;

  @ApiProperty({ example: '2026-08-31T00:00:00.000Z' })
  timestamp!: string;
}
