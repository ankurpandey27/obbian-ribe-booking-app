import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomInt } from 'crypto';
import {
  DevSmsProvider,
  SmsProvider,
  createSmsProvider,
  otpMessage,
} from '../../../common/sms/sms-providers';

const OTP_PREFIX = 'otp:';
const OTP_ATTEMPTS_SUFFIX = ':attempts';

/**
 * OTP service — generate, store (Redis, TTL), verify, cooldown.
 * Provider abstraction: dev (fixed code) | msg91 | twilio.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly provider: string;
  private readonly expirySeconds: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownSeconds: number;
  private readonly devCode: string;
  private readonly sms: SmsProvider;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.provider = config.get<string>('otp.provider', 'dev');
    this.expirySeconds = config.get<number>('otp.expirySeconds', 300);
    this.maxAttempts = config.get<number>('otp.maxAttempts', 5);
    this.resendCooldownSeconds = config.get<number>(
      'otp.resendCooldownSeconds',
      30,
    );
    this.devCode = config.get<string>('otp.devCode', '123456');
    try {
      this.sms = createSmsProvider(config);
    } catch (err) {
      this.logger.warn((err as Error).message);
      this.sms = new DevSmsProvider();
    }
  }

  private key(phone: string): string {
    return `${OTP_PREFIX}${phone}`;
  }

  private attemptsKey(phone: string): string {
    return `${OTP_PREFIX}${phone}${OTP_ATTEMPTS_SUFFIX}`;
  }

  async sendOtp(phone: string): Promise<void> {
    const existingTtl = await this.redis.ttl(this.key(phone));
    const elapsed = this.expirySeconds - Math.max(existingTtl, 0);
    if (existingTtl > 0 && elapsed < this.resendCooldownSeconds) {
      const wait = this.resendCooldownSeconds - elapsed;
      throw new Error(`OTP_RESEND_COOLDOWN:${wait}`);
    }

    const code =
      this.provider === 'dev'
        ? this.devCode
        : randomInt(100000, 999999).toString();

    await this.redis.set(this.key(phone), code, 'EX', this.expirySeconds);
    await this.redis.del(this.attemptsKey(phone));

    if (this.provider !== 'dev') {
      try {
        await this.sms.send(phone, otpMessage(code));
      } catch (err) {
        this.logger.error(`SMS dispatch failed for ${phone}: ${err.message}`);
      }
    }
    this.logger.log(
      `OTP sent to ${phone} (provider=${this.provider}, code=${code})`,
    );
  }

  async verifyOtp(phone: string, otp: string): Promise<boolean> {
    const stored = await this.redis.get(this.key(phone));
    if (!stored) return false;

    const attempts = await this.redis.incr(this.attemptsKey(phone));
    if (attempts > this.maxAttempts) {
      await this.redis.del(this.key(phone));
      return false;
    }

    if (stored !== otp) return false;

    await this.redis.del(this.key(phone));
    await this.redis.del(this.attemptsKey(phone));
    return true;
  }
}
