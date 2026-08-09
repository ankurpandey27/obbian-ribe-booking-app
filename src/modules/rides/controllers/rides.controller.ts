import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RidesService } from '../services/rides.service';
import { PricingService } from '../../pricing/services/pricing.service';
import { PromosService } from '../../promos/services/promos.service';
import { SurgeService } from '../../pricing/services/surge.service';
import { FraudService } from '../services/fraud.service';
import { ScheduledRidesService } from '../services/scheduled-rides.service';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtPayload } from '../../auth/services/token.service';
import {
  RequestRideDto,
  CancelRideDto,
  CancelRideResultDto,
  RateRideDto,
  RateRideResultDto,
  RequestRideResultDto,
  RideDto,
  RideListResultDto,
  ScheduleRideDto,
  ScheduleRideResultDto,
  ScheduledRideListResultDto,
} from '../dto/rides.dto';
import { RideTypeValue } from '../../../shared/types/common';
import { ApiErrorDto } from '../../../common/dto/api-error';

@ApiTags('rides')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorDto,
  description: 'Missing/invalid token',
})
@Controller('rides')
export class RidesController {
  constructor(
    private readonly ridesService: RidesService,
    private readonly pricingService: PricingService,
    private readonly promosService: PromosService,
    private readonly surgeService: SurgeService,
    private readonly fraudService: FraudService,
    private readonly scheduledRidesService: ScheduledRidesService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Request a ride (validates quoted fare, price-locked)',
  })
  @ApiCreatedResponse({ type: RequestRideResultDto })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'Invalid input / duplicate request / promo rejected',
  })
  async requestRide(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RequestRideDto,
  ) {
    await this.fraudService.guardRideRequest(
      user.sub,
      dto.pickupLat,
      dto.pickupLon,
      dto.city ?? 'Delhi',
    );

    const config = await this.pricingService.getConfig(
      dto.city ?? 'Delhi',
      dto.rideType,
    );
    const quote = await this.pricingService.getQuote(
      dto.pickupLat,
      dto.pickupLon,
      dto.dropoffLat,
      dto.dropoffLon,
      dto.city ?? 'Delhi',
      [dto.rideType],
    );

    const estimatedFare = this.pricingService.calculateFare(
      config,
      quote.distanceKm,
      quote.durationMin,
    );
    // Price lock = what the client saw in the quote (surge included).
    const quotedOption = quote.options.find((o) => o.rideType === dto.rideType);
    const lockedFare =
      quotedOption && quote.surgeMultiplier ? quotedOption.fare : estimatedFare;

    // Promo validated at request time; discount locks with the fare.
    let promoDiscount = 0;
    if (dto.promoCode) {
      const promo = await this.promosService.validate(dto.promoCode, user.sub);
      promoDiscount = Math.min(
        Math.round(((lockedFare * promo.discountPercent) / 100) * 2) / 2,
        promo.maxDiscount,
      );
    }

    const ride = await this.ridesService.createRide({
      riderId: user.sub,
      pickupLat: dto.pickupLat,
      pickupLon: dto.pickupLon,
      dropoffLat: dto.dropoffLat,
      dropoffLon: dto.dropoffLon,
      rideType: dto.rideType,
      city: dto.city ?? 'Delhi',
      estimatedFare: lockedFare,
      distanceKm: quote.distanceKm,
      durationMin: Math.max(0, Math.round(quote.durationMin ?? 0)),
      surgeMultiplier: quote.surgeMultiplier ?? Number(config.surgeMultiplier),
      promoCode: dto.promoCode,
      promoDiscount,
    });

    if (dto.promoCode) {
      await this.promosService
        .markUsed(dto.promoCode, user.sub)
        .catch(() => {});
    }
    // Demand signal for the surge engine (best effort, never blocks).
    await this.surgeService.recordDemand(dto.city ?? 'Delhi').catch(() => {});

    return {
      rideId: ride.id,
      estimatedFare: Number(ride.estimatedFare),
      surgeMultiplier: ride.surgeMultiplier,
      promoDiscount,
      payableFare: Number(ride.estimatedFare) - promoDiscount,
      estimatedTime: quote.durationMin,
      status: ride.status,
      driverId: ride.driverId ?? null,
    };
  }

  @Post('schedule')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Book a ride for a future time' })
  @ApiCreatedResponse({ type: ScheduleRideResultDto })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'Invalid booking window',
  })
  async scheduleRide(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ScheduleRideDto,
  ) {
    const scheduled = await this.scheduledRidesService.schedule({
      riderId: user.sub,
      pickupLat: dto.pickupLat,
      pickupLon: dto.pickupLon,
      dropoffLat: dto.dropoffLat,
      dropoffLon: dto.dropoffLon,
      rideType: dto.rideType,
      city: dto.city ?? 'Delhi',
      scheduledFor: new Date(dto.scheduledFor),
    });
    return {
      scheduledRideId: scheduled.id,
      scheduledFor: scheduled.scheduledFor,
      status: scheduled.status,
      rideType: scheduled.rideType,
      pickup: { lat: scheduled.pickupLat, lon: scheduled.pickupLon },
      dropoff: { lat: scheduled.dropoffLat, lon: scheduled.dropoffLon },
    };
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Upcoming scheduled rides for the rider' })
  @ApiOkResponse({ type: ScheduledRideListResultDto })
  async listScheduled(@CurrentUser() user: JwtPayload) {
    const rides = await this.scheduledRidesService.listForRider(user.sub);
    return {
      rides: rides.map((s) => ({
        scheduledRideId: s.id,
        scheduledFor: s.scheduledFor,
        status: s.status,
        rideType: s.rideType,
        rideId: s.rideId ?? null,
      })),
    };
  }

  @Delete('scheduled/:scheduledRideId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an upcoming scheduled ride' })
  @ApiOkResponse({ description: 'Scheduled ride cancelled' })
  @ApiParam({
    name: 'scheduledRideId',
    example: 'a1b2c3d4-...',
  })
  async cancelScheduled(
    @CurrentUser() user: JwtPayload,
    @Param('scheduledRideId') scheduledRideId: string,
  ) {
    return this.scheduledRidesService.cancel(user.sub, scheduledRideId);
  }

  @Get('active')
  @ApiOperation({ summary: 'Active ride for current rider (app resume)' })
  @ApiOkResponse({ type: RideListResultDto })
  async getActive(@CurrentUser() user: JwtPayload) {
    const rides = await this.ridesService.getActiveRidesForRider(user.sub);
    return { rides: rides.map(this.serialize) };
  }

  @Get('history')
  @ApiOperation({ summary: 'Past completed rides' })
  @ApiOkResponse({ type: RideListResultDto })
  @ApiQuery({ name: 'limit', example: 20, required: false })
  @ApiQuery({ name: 'offset', example: 0, required: false })
  async getHistory(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit = 20,
    @Query('offset') offset = 0,
  ) {
    const rides = await this.ridesService.getHistoryForRider(
      user.sub,
      +limit,
      +offset,
    );
    return { rides: rides.map(this.serialize) };
  }

  @Get(':rideId')
  @ApiOperation({ summary: 'Ride details + live driver info' })
  @ApiOkResponse({ type: RideDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Ride not found' })
  async getRide(@Param('rideId') rideId: string) {
    const ride = await this.ridesService.getRide(rideId);
    return this.serialize(ride);
  }

  @Put(':rideId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel ride → refund amount' })
  @ApiOkResponse({ type: CancelRideResultDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'Ride cannot be cancelled',
  })
  async cancelRide(
    @Param('rideId') rideId: string,
    @Body() dto: CancelRideDto,
  ) {
    const result = await this.ridesService.cancel(
      rideId,
      dto.reason,
      dto.cancelledBy ?? 'RIDER',
    );
    return {
      success: true,
      refundAmount: result.refundAmount,
      status: result.ride.status,
    };
  }

  @Post(':rideId/rate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Rate a completed ride' })
  @ApiCreatedResponse({ type: RateRideResultDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'Only completed rides can be rated',
  })
  async rateRide(@Param('rideId') rideId: string, @Body() dto: RateRideDto) {
    const ride = await this.ridesService.getRide(rideId);
    if (ride.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed rides can be rated');
    }
    const patch = dto.asRider
      ? { riderRating: dto.rating }
      : { driverRating: dto.rating };
    await this.ridesService.transition(rideId, 'COMPLETED', patch);
    return { saved: true };
  }

  private serialize(ride: {
    id: string;
    rideType: RideTypeValue;
    status: string;
    pickupLat: number;
    pickupLon: number;
    dropoffLat: number;
    dropoffLon: number;
    estimatedFare: string | number;
    totalFare?: string | number | null;
    distanceKm: string | number;
    durationMin: number;
    driverId?: string;
    createdAt: Date;
    completedAt?: Date | null;
    cancellationReason?: string | null;
    cancellationFee?: string | number | null;
  }) {
    return {
      rideId: ride.id,
      rideType: ride.rideType,
      status: ride.status,
      pickup: { lat: ride.pickupLat, lon: ride.pickupLon },
      dropoff: { lat: ride.dropoffLat, lon: ride.dropoffLon },
      estimatedFare: Number(ride.estimatedFare),
      totalFare: ride.totalFare != null ? Number(ride.totalFare) : null,
      distanceKm: Number(ride.distanceKm),
      durationMin: ride.durationMin,
      driverId: ride.driverId ?? null,
      createdAt: ride.createdAt,
      completedAt: ride.completedAt ?? null,
      cancellationReason: ride.cancellationReason ?? null,
      cancellationFee:
        ride.cancellationFee != null ? Number(ride.cancellationFee) : 0,
    };
  }
}
