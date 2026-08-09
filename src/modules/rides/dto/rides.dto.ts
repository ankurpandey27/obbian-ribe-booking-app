import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CancellationReasonValue,
  RideTypeValue,
} from '../../../shared/types/common';

export class RequestRideDto {
  @ApiProperty({ example: 28.7041 })
  @IsLatitude()
  pickupLat: number;

  @ApiProperty({ example: 77.1025 })
  @IsLongitude()
  pickupLon: number;

  @ApiProperty({ example: 28.5355 })
  @IsLatitude()
  dropoffLat: number;

  @ApiProperty({ example: 77.391 })
  @IsLongitude()
  dropoffLon: number;

  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  @IsEnum(['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'])
  rideType: RideTypeValue;

  @ApiPropertyOptional({ example: 'Delhi' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'Promo code applied at quote time' })
  @IsOptional()
  @MaxLength(20)
  promoCode?: string;
}

export class ScheduleRideDto {
  @ApiProperty({ example: 28.7041 })
  @IsLatitude()
  pickupLat: number;

  @ApiProperty({ example: 77.1025 })
  @IsLongitude()
  pickupLon: number;

  @ApiProperty({ example: 28.5355 })
  @IsLatitude()
  dropoffLat: number;

  @ApiProperty({ example: 77.391 })
  @IsLongitude()
  dropoffLon: number;

  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  @IsEnum(['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'])
  rideType: RideTypeValue;

  @ApiPropertyOptional({ example: 'Delhi' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({
    description: 'ISO datetime (e.g. 2026-08-09T09:30:00+05:30)',
    example: '2026-08-09T09:30:00.000Z',
  })
  @IsString()
  scheduledFor: string;
}

export class CancelRideDto {
  @ApiProperty({
    enum: ['USER_CANCELLED', 'DRIVER_CANCELLED', 'NO_DRIVER_FOUND', 'SYSTEM'],
  })
  @IsEnum(['USER_CANCELLED', 'DRIVER_CANCELLED', 'NO_DRIVER_FOUND', 'SYSTEM'])
  reason: CancellationReasonValue;

  @ApiPropertyOptional({ enum: ['RIDER', 'DRIVER', 'SYSTEM'] })
  @IsOptional()
  @IsString()
  cancelledBy?: 'RIDER' | 'DRIVER' | 'SYSTEM';
}

export class RateRideDto {
  @ApiProperty({ example: 5 })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'Great ride' })
  @IsOptional()
  @MaxLength(500)
  feedback?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  asRider?: boolean;
}

/* ------------------------------ responses ------------------------------ */

export class GeoPointDto {
  @ApiProperty({ example: 28.7041 })
  lat: number;

  @ApiProperty({ example: 77.1025 })
  lon: number;
}

export class RideDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  rideId: string;

  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

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

  @ApiProperty({ type: GeoPointDto })
  pickup: GeoPointDto;

  @ApiProperty({ type: GeoPointDto })
  dropoff: GeoPointDto;

  @ApiProperty({ example: 718.5 })
  estimatedFare: number;

  @ApiProperty({ example: 718.5, nullable: true })
  totalFare: number | null;

  @ApiProperty({ example: 42.14 })
  distanceKm: number;

  @ApiProperty({ example: 46 })
  durationMin: number;

  @ApiProperty({ example: 'b0e2a3f4-...', nullable: true })
  driverId: string | null;

  @ApiProperty({ example: '2026-08-08T16:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-08-08T16:30:00.000Z', nullable: true })
  completedAt: Date | null;

  @ApiProperty({ example: 'USER_CANCELLED', nullable: true })
  cancellationReason: string | null;

  @ApiProperty({ example: 0 })
  cancellationFee: number;
}

export class RideListResultDto {
  @ApiProperty({ type: [RideDto] })
  rides: RideDto[];
}

export class RequestRideResultDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  rideId: string;

  @ApiProperty({ example: 718.5 })
  estimatedFare: number;

  @ApiProperty({ example: 1.0 })
  surgeMultiplier: number;

  @ApiProperty({ example: 0 })
  promoDiscount: number;

  @ApiProperty({ example: 718.5, description: 'Payable after promo' })
  payableFare: number;

  @ApiProperty({ example: 45.7 })
  estimatedTime: number;

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

  @ApiProperty({ example: null, nullable: true })
  driverId: string | null;
}

export class ScheduleRideResultDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  scheduledRideId: string;

  @ApiProperty({ example: '2026-08-09T09:30:00.000Z' })
  scheduledFor: Date;

  @ApiProperty({ example: 'SCHEDULED' })
  status: string;

  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @ApiProperty({ type: GeoPointDto })
  pickup: GeoPointDto;

  @ApiProperty({ type: GeoPointDto })
  dropoff: GeoPointDto;
}

export class ScheduledRideDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  scheduledRideId: string;

  @ApiProperty({ example: '2026-08-09T09:30:00.000Z' })
  scheduledFor: Date;

  @ApiProperty({ example: 'SCHEDULED' })
  status: string;

  @ApiProperty({
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @ApiProperty({ example: 'a1b2c3d4-...', nullable: true })
  rideId: string | null;
}

export class ScheduledRideListResultDto {
  @ApiProperty({ type: [ScheduledRideDto] })
  rides: ScheduledRideDto[];
}

export class CancelRideResultDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 0 })
  refundAmount: number;

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
}

export class RateRideResultDto {
  @ApiProperty({ example: true })
  saved: boolean;
}
