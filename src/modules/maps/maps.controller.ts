import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MapsService } from './maps.service';
import { Public } from '../../common/auth/decorators';
import {
  AddressResultDto,
  RouteInfoDto,
  SuggestionsResultDto,
} from './dto/maps.dto';

@ApiTags('maps')
@Controller('maps')
export class MapsController {
  constructor(private readonly mapsService: MapsService) {}

  @Get('autocomplete')
  @Public()
  @ApiOperation({ summary: 'Place autocomplete (India)' })
  @ApiOkResponse({ type: SuggestionsResultDto })
  @ApiQuery({ name: 'query', example: 'Connaught Place', required: true })
  async autocomplete(
    @Query('query') query: string,
  ): Promise<SuggestionsResultDto> {
    const suggestions = await this.mapsService.autocomplete(query);
    return { suggestions };
  }

  @Get('reverse-geocode')
  @Public()
  @ApiOperation({ summary: 'Reverse geocode lat/lon → address' })
  @ApiOkResponse({ type: AddressResultDto })
  @ApiQuery({ name: 'lat', type: Number, example: 28.7041 })
  @ApiQuery({ name: 'lon', type: Number, example: 77.1025 })
  async reverseGeocode(
    @Query('lat') lat: number,
    @Query('lon') lon: number,
  ): Promise<AddressResultDto> {
    const address = await this.mapsService.reverseGeocode(lat, lon);
    return { address };
  }

  @Get('route')
  @Public()
  @ApiOperation({ summary: 'Road route between two points' })
  @ApiOkResponse({ type: RouteInfoDto })
  @ApiQuery({ name: 'pickupLat', type: Number, example: 28.7041 })
  @ApiQuery({ name: 'pickupLon', type: Number, example: 77.1025 })
  @ApiQuery({ name: 'dropoffLat', type: Number, example: 28.5355 })
  @ApiQuery({ name: 'dropoffLon', type: Number, example: 77.391 })
  async route(
    @Query('pickupLat') pickupLat: number,
    @Query('pickupLon') pickupLon: number,
    @Query('dropoffLat') dropoffLat: number,
    @Query('dropoffLon') dropoffLon: number,
  ): Promise<RouteInfoDto> {
    return this.mapsService.getRoute(
      pickupLat,
      pickupLon,
      dropoffLat,
      dropoffLon,
    );
  }
}
