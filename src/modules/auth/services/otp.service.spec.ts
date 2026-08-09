import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';

function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService(
    Object.assign(
      {
        otp: {
          provider: 'dev',
          expirySeconds: 300,
          maxAttempts: 5,
          resendCooldownSeconds: 30,
          devCode: '123456',
        },
      },
      overrides,
    ),
  );
}

function redisMock() {
  const store = new Map<string, string>();
  return {
    ttl: jest.fn((key: string) => {
      return Promise.resolve(store.has(key) ? 300 : -2);
    }),
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
  };
}

describe('OtpService', () => {
  it('accepts the dev code', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await service.sendOtp('+919999999999');
    await expect(service.verifyOtp('+919999999999', '123456')).resolves.toBe(
      true,
    );
  });

  it('rejects a wrong code', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await service.sendOtp('+919999999999');
    await expect(service.verifyOtp('+919999999999', '000000')).resolves.toBe(
      false,
    );
  });

  it('rejects when no OTP was ever sent', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await expect(service.verifyOtp('+911111111111', '123456')).resolves.toBe(
      false,
    );
  });

  it('invalidates the code after max attempts', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await service.sendOtp('+919999999999');
    for (let i = 0; i < 5; i += 1) {
      await service.verifyOtp('+919999999999', '000000');
    }
    await expect(service.verifyOtp('+919999999999', '000000')).resolves.toBe(
      false,
    );
    // code itself is deleted after the 6th attempt
    await expect(service.verifyOtp('+919999999999', '123456')).resolves.toBe(
      false,
    );
  });

  it('enforces the resend cooldown', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await service.sendOtp('+919999999999');
    await expect(service.sendOtp('+919999999999')).rejects.toThrow(
      'OTP_RESEND_COOLDOWN',
    );
  });

  it('generates a random code when not in dev mode', async () => {
    const redis = redisMock();
    const service = new OtpService(
      redis as never,
      config({ otp: { provider: 'twilio' } }),
    );

    // non-dev: dispatchSms throws by design (no provider wired) but the
    // OTP is still stored before dispatch, so sendOtp must succeed.
    await expect(service.sendOtp('+919999999999')).resolves.toBeUndefined();
    const stored = await redis.get('otp:+919999999999');
    expect(stored).toMatch(/^\d{6}$/);
    expect(stored).not.toBe('123456');
  });

  it('stores and clears the attempts counter correctly', async () => {
    const redis = redisMock();
    const service = new OtpService(redis as never, config());

    await service.sendOtp('+919999999999');
    await service.verifyOtp('+919999999999', '000000');
    const attempts = await redis.get('otp:+919999999999:attempts');
    expect(attempts).toBe('1');
    await service.verifyOtp('+919999999999', '123456');
    await expect(redis.get('otp:+919999999999')).resolves.toBeNull();
  });
});
