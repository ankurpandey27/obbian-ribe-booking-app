import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/decorators';
import { JwtPayload } from '../auth/token.service';
import {
  CreateIncentiveDto,
  CreateZoneDto,
  RedeemReferralDto,
} from './dto/growth.dto';
import { DriverIncentivesService } from './driver-incentives.service';
import { ReferralsService } from './referrals.service';
import { ZonesService } from './zones.service';

@ApiTags('growth')
@ApiBearerAuth()
@Controller('growth')
export class GrowthController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly incentives: DriverIncentivesService,
    private readonly zones: ZonesService,
  ) {}

  @Post('referrals/code')
  @ApiOperation({
    summary: 'Create or retrieve the current user referral code',
  })
  @ApiCreatedResponse()
  createReferralCode(@CurrentUser() user: JwtPayload) {
    return this.referrals.createCode(user.sub);
  }

  @Post('referrals/redeem')
  @ApiOperation({ summary: 'Redeem a referral code once for this account' })
  redeemReferral(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RedeemReferralDto,
  ) {
    return this.referrals.redeem(user.sub, dto.code);
  }

  @Get('referrals')
  @ApiOperation({ summary: 'Get referral qualification status' })
  referralStatus(@CurrentUser() user: JwtPayload) {
    return this.referrals.getStatus(user.sub);
  }

  @Get('incentives')
  @Roles('DRIVER')
  @ApiOperation({ summary: 'List incentives for the current driver' })
  listIncentives(@CurrentUser() user: JwtPayload) {
    return this.incentives.listForDriver(user.sub);
  }

  @Post('incentives')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a driver incentive target' })
  createIncentive(@Body() dto: CreateIncentiveDto) {
    return this.incentives.create({
      ...dto,
      periodStart: new Date(dto.periodStart),
      periodEnd: new Date(dto.periodEnd),
    });
  }

  @Post('zones')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create an active PostGIS operational zone' })
  createZone(@Body() dto: CreateZoneDto) {
    return this.zones.create(dto);
  }

  @Get('zones')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List operational zones' })
  listZones(@Query('city') city?: string) {
    return this.zones.list(city);
  }
}
