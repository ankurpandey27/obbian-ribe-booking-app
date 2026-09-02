import { Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Body, HttpCode, HttpStatus } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../auth/token.service';
import { Roles } from '../../common/auth/decorators';
import {
  DriverLocationResultDto,
  DriverProfileDto,
  DriverRegisterResultDto,
  DriverStatusResultDto,
  RegisterDriverDto,
  UpdateLocationDto,
  UpdateStatusDto,
} from './dto/drivers.dto';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';

@ApiTags('drivers')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register driver profile (any authenticated user)' })
  @ApiCreatedResponse({ type: DriverRegisterResultDto })
  @ApiConflictResponse({
    type: ApiEnvelopeDto,
    description: 'Driver profile already exists for this user',
  })
  async register(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterDriverDto,
  ): Promise<DriverRegisterResultDto> {
    const driver = await this.driversService.register(user.sub, dto);
    return {
      driverId: driver.userId,
      status: driver.status,
      vehicleType: driver.vehicleType,
      message: 'Driver profile created. Re-login to pick up the DRIVER role.',
    };
  }

  @Get('me')
  @Roles('DRIVER')
  @ApiOperation({ summary: 'Own driver profile' })
  @ApiOkResponse({ type: DriverProfileDto })
  async getMyProfile(@CurrentUser() user: JwtPayload) {
    const driver = await this.driversService.getProfile(user.sub);
    return this.serialize(driver);
  }

  @Get(':driverId')
  @ApiOperation({
    summary: 'Driver profile for riders (any authenticated user)',
  })
  @ApiOkResponse({ type: DriverProfileDto })
  @ApiParam({
    name: 'driverId',
    example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Driver not found',
  })
  async getProfile(@Param('driverId') driverId: string) {
    const driver = await this.driversService.getProfile(driverId);
    return this.serialize(driver);
  }

  @Put('status')
  @Roles('DRIVER')
  @ApiOperation({ summary: 'Set ONLINE / OFFLINE / ON_RIDE' })
  @ApiOkResponse({ type: DriverStatusResultDto })
  async updateStatus(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateStatusDto,
  ): Promise<DriverStatusResultDto> {
    await this.driversService.updateStatus(user.sub, dto.status);
    return { updated: true };
  }

  @Post('location')
  @Roles('DRIVER')
  @ApiOperation({ summary: 'Push live location (3-5s cadence)' })
  @ApiOkResponse({ type: DriverLocationResultDto })
  async updateLocation(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateLocationDto,
  ): Promise<DriverLocationResultDto> {
    const valid = await this.driversService.validateLocationJump(
      user.sub,
      dto.lat,
      dto.lon,
      dto.timestamp,
    );
    if (!valid) {
      return { updated: false, reason: 'IMPLAUSIBLE_JUMP' };
    }
    await this.driversService.updateLocation(
      user.sub,
      dto.lat,
      dto.lon,
      dto.timestamp,
    );
    return { updated: true };
  }

  private serialize(driver: {
    userId: string;
    rating: string | number;
    vehicleType: string;
    vehicleModel?: string;
    vehicleColor?: string;
    vehicleRegistration: string;
    licenseNumber: string;
    totalRides: number;
    status: string;
  }): DriverProfileDto {
    return {
      driverId: driver.userId,
      name: undefined, // joined from users profile
      rating: Number(driver.rating),
      vehicle: {
        type: driver.vehicleType as DriverProfileDto['vehicle']['type'],
        model: driver.vehicleModel,
        color: driver.vehicleColor,
        registration: driver.vehicleRegistration,
      },
      license: driver.licenseNumber,
      totalRides: driver.totalRides,
      status: driver.status as DriverProfileDto['status'],
    };
  }
}
