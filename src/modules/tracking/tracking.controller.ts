import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TrackingService } from './services/tracking.service';
import { EtaDto, TrackingDto } from './dto/tracking.dto';
import { ApiErrorDto } from '../../common/dto/api-error';

@ApiTags('tracking')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorDto,
  description: 'Missing/invalid token',
})
@Controller('rides')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get(':rideId/tracking')
  @ApiOperation({
    summary: 'REST fallback: current driver position + route + ETA',
  })
  @ApiOkResponse({ type: TrackingDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Ride not found' })
  async tracking(@Param('rideId') rideId: string): Promise<TrackingDto> {
    return this.trackingService.getTracking(rideId);
  }

  @Get(':rideId/eta')
  @ApiOperation({ summary: 'ETA + distance (cached 30s)' })
  @ApiOkResponse({ type: EtaDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Ride not found' })
  async eta(@Param('rideId') rideId: string): Promise<EtaDto> {
    const { eta } = await this.trackingService.getTracking(rideId);
    return eta;
  }
}
