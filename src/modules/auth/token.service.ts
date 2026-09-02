import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { refreshTokens } from '../../common/database/schema';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { AuthResponseDto } from './dto/auth.dto';
import { User } from '../users/entities/user.entity';
import {
  UserLookupPort,
  USER_LOOKUP,
} from '../../shared/contracts/user-lookup.port';

/** Bridge type until the entity sweep (ADR-002). */
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
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
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

    await this.db.insert(refreshTokens).values({
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
    const [stored] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, this.hash(refreshToken)))
      .limit(1);
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotation = one-time use. Grace window: a token rotated within the last
    // GRACE_SECONDS is treated as an in-flight duplicate (two tabs, a retry
    // after a network blip) → return fresh tokens WITHOUT revoking the family.
    // Only reuse detected AFTER the grace window is treated as theft.
    const GRACE_SECONDS = 10;
    if (stored.rotatedAt) {
      const ageMs = Date.now() - new Date(stored.rotatedAt).getTime();
      if (ageMs > GRACE_SECONDS * 1000) {
        await this.revokeAllForUser(stored.userId);
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      // Grace-window duplicate: issue a fresh pair but do NOT rotate again
      // (idempotent within the window).
      const user = await this.users.findById(stored.userId);
      if (!user) throw new UnauthorizedException('User no longer exists');
      return this.issueTokens(user, deviceInfo);
    }

    await this.db
      .update(refreshTokens)
      .set({ rotatedAt: new Date() })
      .where(eq(refreshTokens.id, stored.id));

    const user = await this.users.findById(stored.userId);
    if (!user) throw new UnauthorizedException('User no longer exists');

    return this.issueTokens(user, deviceInfo);
  }

  async revoke(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.tokenHash, this.hash(refreshToken)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
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
