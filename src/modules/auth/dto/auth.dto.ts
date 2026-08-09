import { IsPhoneNumber, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({ example: '+919876543210', description: 'E.164 format' })
  @IsPhoneNumber('IN', { message: 'phone must be a valid Indian phone number' })
  phone: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+919876543210' })
  @IsPhoneNumber('IN', { message: 'phone must be a valid Indian phone number' })
  phone: string;

  @ApiProperty({ example: '123456', minLength: 4, maxLength: 6 })
  @MaxLength(6)
  otp: string;
}

export class RefreshDto {
  @ApiProperty({ example: 'refresh-token-value' })
  @IsString()
  refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Refresh token being revoked (omitted → all sessions)',
  })
  @IsString()
  refreshToken?: string;
}

export class AuthUserDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  id: string;

  @ApiProperty({ example: '+919876543210' })
  phoneNumber: string;

  @ApiProperty({ enum: ['RIDER', 'DRIVER', 'ADMIN'] })
  role: string;
}

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  accessToken: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...' })
  refreshToken: string;

  @ApiProperty({ example: 3600 })
  expiresIn: number;

  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;
}

export class SendOtpResultDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'OTP sent' })
  message: string;
}

export class LogoutResultDto {
  @ApiProperty({ example: true })
  success: boolean;
}
