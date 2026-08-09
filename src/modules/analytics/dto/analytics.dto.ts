import { ApiProperty } from '@nestjs/swagger';

export class AnalyticsTotalsDto {
  @ApiProperty({ example: 142 })
  ridesRequested: number;

  @ApiProperty({ example: 118 })
  ridesCompleted: number;

  @ApiProperty({ example: 24 })
  ridesCancelled: number;

  @ApiProperty({ example: 0.169 })
  cancellationRate: number;

  @ApiProperty({ example: 84730.5 })
  gmv: number;

  @ApiProperty({ example: 718.5 })
  avgFare: number;

  @ApiProperty({ example: 4.8 })
  avgRiderRating: number;

  @ApiProperty({ example: 4.7 })
  avgDriverRating: number;
}

export class RidesPerDayDto {
  @ApiProperty({ example: '2026-08-08' })
  date: string;

  @ApiProperty({ example: 12 })
  count: number;

  @ApiProperty({ example: 8622.0 })
  gmv: number;
}

export class TopRouteDto {
  @ApiProperty({ example: '28.70,77.10 → 28.54,77.39' })
  route: string;

  @ApiProperty({ example: 34 })
  count: number;
}

export class DriverFleetDto {
  @ApiProperty({ example: 7 })
  onlineNow: number;

  @ApiProperty({ example: 21 })
  totalDrivers: number;
}

export class AnalyticsSummaryDto {
  @ApiProperty({ example: '2026-07-09T00:00:00.000Z' })
  from: string;

  @ApiProperty({ example: '2026-08-08T00:00:00.000Z' })
  to: string;

  @ApiProperty({ type: AnalyticsTotalsDto })
  totals: AnalyticsTotalsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { COMPLETED: 118, CANCELLED: 24, REQUESTED: 2 },
  })
  ridesByStatus: Record<string, number>;

  @ApiProperty({ type: [RidesPerDayDto] })
  ridesPerDay: RidesPerDayDto[];

  @ApiProperty({ type: [TopRouteDto] })
  topRoutes: TopRouteDto[];

  @ApiProperty({ type: DriverFleetDto })
  drivers: DriverFleetDto;
}
