import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TrackingService } from './tracking.service';
import { RideParticipantGuard } from '../rides/guards/ride-participant.guard';
import { EtaDto, TrackingDto } from './dto/tracking.dto';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../auth/token.service';

@ApiTags('tracking')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('rides')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get(':rideId/tracking')
  @UseGuards(RideParticipantGuard)
  @ApiOperation({
    summary: 'REST fallback: current driver position + route + ETA',
  })
  @ApiOkResponse({ type: TrackingDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiEnvelopeDto, description: 'Ride not found' })
  async tracking(
    @Param('rideId') rideId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<TrackingDto> {
    return this.trackingService.getTracking(rideId, user.sub);
  }

  @Get(':rideId/eta')
  @UseGuards(RideParticipantGuard)
  @ApiOperation({ summary: 'ETA + distance (cached 30s)' })
  @ApiOkResponse({ type: EtaDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiEnvelopeDto, description: 'Ride not found' })
  async eta(
    @Param('rideId') rideId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<EtaDto> {
    const { eta } = await this.trackingService.getTracking(rideId, user.sub);
    return eta;
  }
}
