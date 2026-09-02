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

/** Driver supplies the rider's boarding code to start the trip. */
export class StartRideDto {
  @ApiProperty({
    example: '4821',
    description: '4-digit pickup code the rider reads to the driver',
  })
  @IsString()
  code!: string;
}

/** Arrive response — includes the boarding code the rider must share with the driver. */
export class ArriveResultDto {
  @ApiProperty({ enum: ['ARRIVED'] })
  status: string;

  @ApiProperty({
    example: '4821',
    description: 'One-time pickup code. Rider reads this to the driver.',
  })
  boardingCode: string;
}
