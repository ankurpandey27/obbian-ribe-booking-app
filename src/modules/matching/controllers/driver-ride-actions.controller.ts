import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MatchingService } from '../services/matching.service';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtPayload } from '../../auth/services/token.service';
import { Roles } from '../../../common/auth/decorators';
import {
  AcceptRideDto,
  AcceptRideResultDto,
  RejectRideDto,
  RejectRideResultDto,
  RideActionStatusDto,
} from '../dto/ride-actions.dto';
import { RidesService } from '../../rides/services/rides.service';
import { ApiErrorDto } from '../../../common/dto/api-error';

/**
 * Driver ride actions — accept/reject offers.
 * Routes through the matching service so the ATOMIC claim stays the
 * single path to ride assignment (no way to double-book).
 */
@ApiTags('drivers')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorDto,
  description: 'Missing/invalid token',
})
@Controller('drivers')
export class DriverRideActionsController {
  constructor(
    private readonly matchingService: MatchingService,
    private readonly ridesService: RidesService,
  ) {}

  /** Guard: only the driver assigned to the ride may act on it. */
  private async assertAssignedDriver(rideId: string, driverId: string) {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.driverId !== driverId) {
      throw new ForbiddenException('Ride is not assigned to this driver');
    }
    return ride;
  }

  @Post('accept-ride')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a ride offer (atomic — first accept wins)' })
  @ApiOkResponse({ type: AcceptRideResultDto })
  async acceptRide(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AcceptRideDto,
  ): Promise<AcceptRideResultDto> {
    const accepted = await this.matchingService.handleDriverResponse(
      dto.rideId,
      user.sub,
      true,
    );
    return {
      accepted,
      message: accepted
        ? 'Ride accepted'
        : 'Ride already taken by another driver',
    };
  }

  @Post('reject-ride')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a ride offer' })
  @ApiOkResponse({ type: RejectRideResultDto })
  async rejectRide(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RejectRideDto,
  ): Promise<RejectRideResultDto> {
    await this.matchingService.handleDriverResponse(
      dto.rideId,
      user.sub,
      false,
    );
    return { rejected: true };
  }

  @Post('rides/:rideId/arrived')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Driver arrived at pickup point' })
  @ApiOkResponse({ type: RideActionStatusDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiForbiddenResponse({
    type: ApiErrorDto,
    description: 'Ride is not assigned to this driver',
  })
  async arrived(
    @CurrentUser() user: JwtPayload,
    @Param('rideId') rideId: string,
  ): Promise<RideActionStatusDto> {
    await this.assertAssignedDriver(rideId, user.sub);
    const ride = await this.ridesService.driverArrive(rideId);
    return { status: ride.status };
  }

  @Post('rides/:rideId/start')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Driver started the trip' })
  @ApiOkResponse({ type: RideActionStatusDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiForbiddenResponse({
    type: ApiErrorDto,
    description: 'Ride is not assigned to this driver',
  })
  async start(
    @CurrentUser() user: JwtPayload,
    @Param('rideId') rideId: string,
  ): Promise<RideActionStatusDto> {
    await this.assertAssignedDriver(rideId, user.sub);
    const ride = await this.ridesService.driverStart(rideId);
    return { status: ride.status };
  }

  @Post('rides/:rideId/complete')
  @Roles('DRIVER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Driver completed the trip (final fare computed)' })
  @ApiOkResponse({ type: RideActionStatusDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiForbiddenResponse({
    type: ApiErrorDto,
    description: 'Ride is not assigned to this driver',
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('rideId') rideId: string,
  ): Promise<RideActionStatusDto> {
    await this.assertAssignedDriver(rideId, user.sub);
    const ride = await this.ridesService.completeRide(rideId);
    return { status: ride.status, totalFare: Number(ride.totalFare) };
  }
}
