import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../services/auth.service';
import { Public } from '../../../common/auth/decorators';
import {
  AuthResponseDto,
  LogoutDto,
  LogoutResultDto,
  RefreshDto,
  SendOtpDto,
  SendOtpResultDto,
  VerifyOtpDto,
} from '../dto/auth.dto';
import { ApiErrorDto } from '../../../common/dto/api-error';

/**
 * Auth endpoints are the brute-force surface (OTP guessing, token stuffing).
 * Strict per-IP limits OVERRIDE the global throttle on these routes:
 * send-otp: 3/10min, verify-otp: 5/10min, refresh: 10/min.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @ApiOperation({ summary: 'Send OTP to phone (cooldown enforced)' })
  @ApiOkResponse({ type: SendOtpResultDto })
  @ApiBadRequestResponse({ type: ApiErrorDto, description: 'Invalid phone' })
  async sendOtp(@Body() dto: SendOtpDto): Promise<SendOtpResultDto> {
    return this.authService.sendOtp(dto.phone);
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: 'Verify OTP → access + refresh tokens' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({
    type: ApiErrorDto,
    description: 'Invalid or expired OTP',
  })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthResponseDto> {
    return this.authService.verifyOtp(dto.phone, dto.otp);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate refresh token → new token pair' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({
    type: ApiErrorDto,
    description: 'Invalid/expired refresh token',
  })
  refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke refresh token' })
  @ApiOkResponse({ type: LogoutResultDto })
  async logout(@Body() dto: LogoutDto): Promise<LogoutResultDto> {
    await this.authService.logout(dto.refreshToken);
    return { success: true };
  }
}
