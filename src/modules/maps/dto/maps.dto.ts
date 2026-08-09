import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlaceSuggestionDto {
  @ApiProperty({ example: 'ChIJLbZ-NCv9DDkRzk0gTMoGZhM' })
  placeId: string;

  @ApiProperty({ example: 'Connaught Place, New Delhi, Delhi, India' })
  address: string;

  @ApiProperty({ example: 28.6315 })
  lat: number;

  @ApiProperty({ example: 77.2167 })
  lon: number;
}

export class SuggestionsResultDto {
  @ApiProperty({ type: [PlaceSuggestionDto] })
  suggestions: PlaceSuggestionDto[];
}

export class AddressResultDto {
  @ApiProperty({ example: 'Sector 62, Noida, Uttar Pradesh 201301, India' })
  address: string;
}

export class RouteInfoDto {
  @ApiProperty({ example: 42.14, description: 'Road distance in km' })
  distanceKm: number;

  @ApiProperty({ example: 45.7, description: 'Road duration in minutes' })
  durationMin: number;

  @ApiPropertyOptional({
    example: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    description: 'Encoded polyline (overview, 5th decimal)',
  })
  polyline?: string;
}
