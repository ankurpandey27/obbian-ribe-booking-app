import { IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AcceptRideDto {
  @ApiProperty({ example: 'ride-uuid' })
  @IsUUID()
  rideId: string;
}

export class RejectRideDto {
  @ApiProperty({ example: 'ride-uuid' })
  @IsUUID()
  rideId: string;

  @ApiPropertyOptional({ example: 'Pickup too far' })
  @IsString()
  reason?: string;
}

/* ------------------------------ responses ------------------------------ */

export class AcceptRideResultDto {
  @ApiProperty({ example: true })
  accepted: boolean;

  @ApiProperty({
    example: 'Ride accepted',
    description: 'Message when the offer was already taken',
  })
  message: string;
}

export class RejectRideResultDto {
  @ApiProperty({ example: true })
  rejected: boolean;
}

export class RideActionStatusDto {
  @ApiProperty({
    enum: [
      'REQUESTED',
      'MATCHING',
      'ACCEPTED',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ],
  })
  status: string;

  @ApiPropertyOptional({ example: 718.5, description: 'Present on complete' })
  totalFare?: number;
}
