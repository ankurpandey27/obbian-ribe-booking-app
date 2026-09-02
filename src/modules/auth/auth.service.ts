import { BadRequestException, Injectable } from '@nestjs/common';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';
import { AuthResponseDto } from './dto/auth.dto';

/**
 * AuthService — orchestrates OTP verification → user find-or-create → token issue.
 * Pure orchestration; business rules live in OtpService/TokenService.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly tokenService: TokenService,
    private readonly usersService: UsersService,
  ) {}

  async sendOtp(phone: string): Promise<{ success: boolean; message: string }> {
    await this.otpService.sendOtp(phone);
    return { success: true, message: 'OTP sent' };
  }

  async verifyOtp(
    phone: string,
    otp: string,
    deviceInfo?: string,
  ): Promise<AuthResponseDto> {
    const valid = await this.otpService.verifyOtp(phone, otp);
    if (!valid) {
      throw new BadRequestException('Invalid or expired OTP');
    }

    const user = await this.usersService.findOrCreate(phone);
    await this.usersService.markLogin(user.id);
    return this.tokenService.issueTokens(user, deviceInfo);
  }

  refresh(refreshToken: string): Promise<AuthResponseDto> {
    return this.tokenService.rotate(refreshToken);
  }

  async logout(refreshToken?: string): Promise<void> {
    await this.tokenService.revoke(refreshToken);
  }
}
