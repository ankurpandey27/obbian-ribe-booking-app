import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomInt } from 'crypto';
import {
  DevSmsProvider,
  SmsProvider,
  createSmsProvider,
  otpMessage,
} from '../../common/sms/sms-providers';

const OTP_PREFIX = 'otp:';
const OTP_ATTEMPTS_SUFFIX = ':attempts';
const OTP_SENT_SUFFIX = ':sent';

/**
 * OTP service — generate, store (Redis, TTL), verify, cooldown.
 * Provider abstraction: dev (fixed code) | msg91 | twilio.
 *
 * Brute-force hardening:
 * - Per-code attempt cap (maxAttempts) with no reset on resend — failing 5
 *   times locks the code permanently; a resend does NOT give a fresh 5.
 * - Per-phone send cap (maxSendsPerHour) with a sliding-hour sent counter —
 *   an attacker cannot loop send→fail→resend to get unlimited guesses
 *   against fresh codes. The counter TTLs out independently of any single
 *   code's TTL.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly provider: string;
  private readonly expirySeconds: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownSeconds: number;
  private readonly maxSendsPerHour: number;
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
    this.maxSendsPerHour = config.get<number>('otp.maxSendsPerHour', 5);
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

  private sentKey(phone: string): string {
    return `${OTP_PREFIX}${phone}${OTP_SENT_SUFFIX}`;
  }

  async sendOtp(phone: string): Promise<void> {
    const existingTtl = await this.redis.ttl(this.key(phone));
    const elapsed = this.expirySeconds - Math.max(existingTtl, 0);
    if (existingTtl > 0 && elapsed < this.resendCooldownSeconds) {
      const wait = this.resendCooldownSeconds - elapsed;
      throw new Error(`OTP_RESEND_COOLDOWN:${wait}`);
    }

    // Sliding-hour send cap: independent of any single code's TTL. Prevents
    // the send→fail→resend loop from minting unlimited fresh codes to guess
    // against.
    const sentCount = await this.redis.incr(this.sentKey(phone));
    if (sentCount === 1) {
      // First send in a new window — start the 1-hour TTL.
      await this.redis.expire(this.sentKey(phone), 3600);
    }
    if (sentCount > this.maxSendsPerHour) {
      throw new Error('OTP_SEND_CAP_EXCEEDED');
    }

    const code =
      this.provider === 'dev'
        ? this.devCode
        : randomInt(100000, 999999).toString();

    await this.redis.set(this.key(phone), code, 'EX', this.expirySeconds);
    // NOTE: intentionally do NOT reset the attempts counter on resend. A failed
    // verify that exhausts attempts must stay exhausted — resending gives a
    // new code but the attacker does not get fresh guesses.

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
