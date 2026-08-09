import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PricingService } from './services/pricing.service';
import { QuoteResult } from './services/pricing.service';
import { RideTypeValue } from '../../shared/types/common';
import { Public } from '../../common/auth/decorators';

@ApiTags('pricing')
@Controller('rides')
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Get('quote')
  @Public()
  @ApiOperation({ summary: 'Fare quote for all ride types (screen 5)' })
  @ApiOkResponse({ type: QuoteResult })
  @ApiQuery({
    name: 'pickupLat',
    type: Number,
    example: 28.7041,
    required: true,
  })
  @ApiQuery({
    name: 'pickupLon',
    type: Number,
    example: 77.1025,
    required: true,
  })
  @ApiQuery({
    name: 'dropoffLat',
    type: Number,
    example: 28.5355,
    required: true,
  })
  @ApiQuery({
    name: 'dropoffLon',
    type: Number,
    example: 77.391,
    required: true,
  })
  @ApiQuery({ name: 'city', example: 'Delhi', required: false })
  @ApiQuery({
    name: 'rideType',
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
    required: false,
    description: 'Restrict quote to a single ride type',
  })
  async quote(
    @Query('pickupLat') pickupLat: string,
    @Query('pickupLon') pickupLon: string,
    @Query('dropoffLat') dropoffLat: string,
    @Query('dropoffLon') dropoffLon: string,
    @Query('city') city = 'Delhi',
    @Query('rideType') rideType?: RideTypeValue,
  ): Promise<QuoteResult> {
    return this.pricingService.getQuote(
      Number(pickupLat),
      Number(pickupLon),
      Number(dropoffLat),
      Number(dropoffLon),
      city,
      rideType ? [rideType] : undefined,
    );
  }
}
