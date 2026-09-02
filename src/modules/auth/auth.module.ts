import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { UsersModule } from '../users/users.module';

@Global()
@Module({
  imports: [UsersModule, JwtModule.register({ global: true })],
  controllers: [AuthController],
  providers: [AuthService, OtpService, TokenService],
  exports: [TokenService, OtpService],
})
export class AuthModule {}
