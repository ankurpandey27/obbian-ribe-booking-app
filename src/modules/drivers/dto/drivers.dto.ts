import {
  IsEnum,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DriverStatusValue } from '../../../shared/types/common';

export class RegisterDriverDto {
  @ApiProperty({ example: 'DL-04201145678' })
  @IsString()
  @MaxLength(50)
  licenseNumber: string;

  @ApiProperty({ example: 'DL-01-CA-1234' })
  @IsString()
  @MaxLength(50)
  vehicleRegistration: string;

  @ApiPropertyOptional({ example: 'Maruti Suzuki Dzire' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleModel?: string;

  @ApiPropertyOptional({ example: 'White' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  vehicleColor?: string;

  @ApiProperty({
    example: 'CABX',
    description: 'Vehicle class code. See GET /catalog for active codes.',
  })
  @IsString()
  @MaxLength(32)
  vehicleType: string;

  @ApiPropertyOptional({ example: 'upi@bank' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  upiId?: string;
}

export class UpdateStatusDto {
  @ApiProperty({ enum: ['ONLINE', 'OFFLINE', 'ON_RIDE'] })
  @IsEnum(['ONLINE', 'OFFLINE', 'ON_RIDE'])
  status: DriverStatusValue;
}

export class UpdateLocationDto {
  @ApiProperty({ example: 28.7041 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 77.1025 })
  @IsLongitude()
  lon: number;

  @ApiProperty({ description: 'Unix ms', example: 1723123456789 })
  @IsNumber()
  @Min(0)
  timestamp: number;
}

/* ------------------------------ responses ------------------------------ */

export class DriverRegisterResultDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  driverId: string;

  @ApiProperty({ enum: ['OFFLINE', 'ONLINE', 'ON_RIDE'], example: 'OFFLINE' })
  status: DriverStatusValue;

  @ApiProperty({ example: 'CABX', description: 'Vehicle class code' })
  vehicleType: string;

  @ApiProperty({
    example: 'Driver profile created. Re-login to pick up the DRIVER role.',
  })
  message: string;
}

export class DriverVehicleDto {
  @ApiProperty({ example: 'CABX', description: 'Vehicle class code' })
  type: string;

  @ApiPropertyOptional({ example: 'Maruti Suzuki Dzire' })
  model?: string;

  @ApiPropertyOptional({ example: 'White' })
  color?: string;

  @ApiProperty({ example: 'DL-01-CA-1234' })
  registration: string;
}

export class DriverProfileDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  driverId: string;

  @ApiPropertyOptional({ example: 'Ramesh Kumar' })
  name?: string;

  @ApiProperty({ example: 4.8, description: '0–5, one decimal' })
  rating: number;

  @ApiProperty({ type: DriverVehicleDto })
  vehicle: DriverVehicleDto;

  @ApiProperty({ example: 'DL-04201145678' })
  license: string;

  @ApiProperty({ example: 142 })
  totalRides: number;

  @ApiProperty({ enum: ['OFFLINE', 'ONLINE', 'ON_RIDE'] })
  status: DriverStatusValue;
}

export class DriverStatusResultDto {
  @ApiProperty({ example: true })
  updated: boolean;
}

export class DriverLocationResultDto {
  @ApiProperty({ example: true })
  updated: boolean;

  @ApiPropertyOptional({
    enum: ['IMPLAUSIBLE_JUMP'],
    example: 'IMPLAUSIBLE_JUMP',
    description: 'Present when the update was rejected',
  })
  reason?: string;
}
