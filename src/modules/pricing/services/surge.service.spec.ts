import { ConfigService } from '@nestjs/config';
import { SurgeService } from './surge.service';

function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService(
    Object.assign(
      {
        surge: {
          enabled: true,
          maxMultiplier: 2.5,
          windowMinutes: 10,
          demandThreshold: 1.5,
          multiplierStep: 0.25,
          cacheTtlSeconds: 60,
        },
      },
      overrides,
    ),
  );
}

function redisMock(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  };
}

function driverRepo(count: number) {
  return { count: jest.fn().mockResolvedValue(count) };
}

describe('SurgeService', () => {
  it('returns 1.0 and records nothing when disabled', async () => {
    const redis = redisMock();
    const service = new SurgeService(
      redis as never,
      driverRepo(0) as never,
      config({ surge: { enabled: false } }),
    );

    await service.recordDemand('Delhi');
    expect(redis.incr).not.toHaveBeenCalled();
    await expect(service.getMultiplier('Delhi')).resolves.toBe(1.0);
  });

  it('returns 1.0 when demand is below the threshold', async () => {
    const redis = redisMock({ 'surge:demand:Delhi': '4' });
    const service = new SurgeService(
      redis as never,
      driverRepo(10) as never, // ratio 0.4
      config(),
    );

    await expect(service.getMultiplier('Delhi')).resolves.toBe(1.0);
  });

  it('steps the multiplier up when demand exceeds supply', async () => {
    const redis = redisMock({ 'surge:demand:Delhi': '30' });
    const service = new SurgeService(
      redis as never,
      driverRepo(10) as never, // ratio 3.0 â†’ 1 + ceil(1.5/0.25)Ã—0.25 = 2.5
      config(),
    );

    await expect(service.getMultiplier('Delhi')).resolves.toBe(2.5);
  });

  it('caps the multiplier at the configured maximum', async () => {
    const redis = redisMock({ 'surge:demand:Delhi': '999' });
    const service = new SurgeService(
      redis as never,
      driverRepo(1) as never, // huge ratio
      config(),
    );

    await expect(service.getMultiplier('Delhi')).resolves.toBe(2.5);
  });

  it('serves a cached multiplier without recomputing', async () => {
    const redis = redisMock({ 'surge:multiplier:Delhi': '2.25' });
    const repo = driverRepo(0);
    const service = new SurgeService(redis as never, repo as never, config());

    await expect(service.getMultiplier('Delhi')).resolves.toBe(2.25);
    expect(repo.count).not.toHaveBeenCalled();
  });

  it('rounds multipliers to 2 decimals', async () => {
    const redis = redisMock({ 'surge:demand:Delhi': '16' });
    const service = new SurgeService(
      redis as never,
      driverRepo(10) as never, // ratio 1.6 â†’ 1 + ceil(0.1/0.25)Ã—0.25 = 1.25
      config(),
    );

    await expect(service.getMultiplier('Delhi')).resolves.toBe(1.25);
  });
});
