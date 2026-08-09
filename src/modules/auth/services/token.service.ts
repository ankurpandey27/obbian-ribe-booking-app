import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { RefreshToken } from '../entities/refresh-token.entity';
import { AuthResponseDto } from '../dto/auth.dto';
import { User } from '../../users/entities/user.entity';
import {
  UserLookupPort,
  USER_LOOKUP,
} from '../../../shared/contracts/user-lookup.port';
import { JwtService } from '@nestjs/jwt';

export interface JwtPayload {
  sub: string; // userId
  role: string;
  phone: string;
}

/**
 * TokenService — access token (short-lived JWT) + refresh token (opaque, rotated).
 * Refresh tokens are hashed at rest, one-time use, rotated on every refresh;
 * reuse of a rotated token is treated as theft and revokes the whole family.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(RefreshToken)
    private readonly refreshRepo: Repository<RefreshToken>,
    private readonly config: ConfigService,
    @Inject(USER_LOOKUP) private readonly users: UserLookupPort,
  ) {}

  async issueTokens(user: User, deviceInfo?: string): Promise<AuthResponseDto> {
    const accessToken = await this.jwt.signAsync(this.buildPayload(user), {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<number>('jwt.accessTtl', 900),
    });

    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(
      Date.now() + this.config.get<number>('jwt.refreshTtl', 2592000) * 1000,
    );

    await this.refreshRepo.save({
      userId: user.id,
      tokenHash: this.hash(refreshToken),
      expiresAt,
      deviceInfo,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get<number>('jwt.accessTtl', 900),
      user: { id: user.id, phoneNumber: user.phoneNumber, role: user.role },
    };
  }

  /** Rotate: validate → revoke old → issue new pair. */
  async rotate(
    refreshToken: string,
    deviceInfo?: string,
  ): Promise<AuthResponseDto> {
    const stored = await this.refreshRepo.findOneBy({
      tokenHash: this.hash(refreshToken),
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation = one-time use. If already rotated, likely stolen → revoke all.
    if (stored.rotatedAt) {
      await this.revokeAllForUser(stored.userId);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    stored.rotatedAt = new Date();
    await this.refreshRepo.save(stored);

    const user = await this.users.findById(stored.userId);
    if (!user) throw new UnauthorizedException('User no longer exists');

    return this.issueTokens(user, deviceInfo);
  }

  async revoke(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    await this.refreshRepo.update(
      { tokenHash: this.hash(refreshToken) },
      { revokedAt: new Date() },
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshRepo.update(
      { userId, revokedAt: undefined },
      { revokedAt: new Date() },
    );
  }

  async verifyAccess(token: string): Promise<JwtPayload> {
    try {
      return await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private buildPayload(user: User): JwtPayload {
    return { sub: user.id, role: user.role, phone: user.phoneNumber };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
