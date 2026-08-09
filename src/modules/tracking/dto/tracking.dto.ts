import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RouteInfoDto } from '../../maps/dto/maps.dto';
import { GeoPointDto } from '../../rides/dto/rides.dto';

export class DriverPositionDto {
  @ApiProperty({ example: 28.7041 })
  lat: number;

  @ApiProperty({ example: 77.1025 })
  lon: number;

  @ApiProperty({ example: 1723123456789, description: 'Unix ms' })
  lastUpdate: number;
}

export class EtaDto {
  @ApiProperty({ example: 12 })
  etaMinutes: number;

  @ApiProperty({ example: 8.4 })
  distanceKm: number;
}

export class TrackingDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  rideId: string;

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

  @ApiPropertyOptional({
    type: DriverPositionDto,
    description: 'Latest driver position (null until matched)',
  })
  driver: DriverPositionDto | null;

  @ApiProperty({ type: GeoPointDto })
  pickup: GeoPointDto;

  @ApiProperty({ type: GeoPointDto })
  dropoff: GeoPointDto;

  @ApiPropertyOptional({
    type: RouteInfoDto,
    description: 'Route for accepted/in-progress rides',
  })
  route: RouteInfoDto | null;

  @ApiProperty({ type: EtaDto })
  eta: EtaDto;
}
