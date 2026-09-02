import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { TokenService } from '../../modules/auth/token.service';
import { JwtPayload } from '../../modules/auth/token.service';
import { IS_PUBLIC_KEY } from './decorators';

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

/**
 * JwtAuthGuard — verifies Bearer token, attaches payload to request.user.
 * Global guard; endpoints opt out with @Public() (auth OTP/refresh, maps).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = auth.slice(7);
    request.user = await this.tokenService.verifyAccess(token);
    return true;
  }
}
