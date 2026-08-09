import { ApiProperty } from '@nestjs/swagger';

/**
 * Unified error response contract.
 * Every failure returns this shape (see ApiErrorFilter).
 */
export class ApiErrorDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({
    example: ['phone must be a valid Indian phone number'],
    description: 'Human-readable message (or list of validation errors)',
  })
  message: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({ example: '2026-08-08T16:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/v1/rides/request' })
  path: string;

  @ApiProperty({
    example: '9f2c1a4e-7b3d-4c5e-8f0a-1b2c3d4e5f6a',
    description: 'Correlates the response with server logs',
  })
  requestId: string;
}

/** @deprecated use ApiErrorDto */
export type ApiErrorBody = ApiErrorDto;

/** Generic success acknowledgement body. */
export class SuccessDto {
  @ApiProperty({ example: true })
  success: boolean;
}
