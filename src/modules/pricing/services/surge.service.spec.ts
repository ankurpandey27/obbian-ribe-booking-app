import { ConfigService } from '@nestjs/config';
import { SurgeService } from './surge.service';

// Fixed pickup point — every test maps to the same deterministic H3 cell.
const LAT = 28.7041;
const LON = 77.1025;

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
    store,
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

function geoMock(supplyCount: number) {
  return {
    findNearbyDriverIds: jest
      .fn()
      .mockResolvedValue(Array.from({ length: supplyCount }, (_, i) => `d${i}`)),
  };
}

/** Demand key for the fixed pickup's cell (mirrors service internals). */
function demandKey(service: SurgeService): string {
  return `surge:demand:Delhi:${service.toCell(LAT, LON)}`;
}

function multiplierKey(service: SurgeService): string {
  return `surge:multiplier:Delhi:${service.toCell(LAT, LON)}`;
}

describe('SurgeService', () => {
  it('returns 1.0 and records nothing when disabled', async () => {
    const redis = redisMock();
    const service = new SurgeService(
      redis as never,
      geoMock(0) as never,
      config({ surge: { enabled: false } }),
    );

    await service.recordDemand('Delhi', LAT, LON);
    expect(redis.incr).not.toHaveBeenCalled();
    await expect(
      service.getMultiplier('Delhi', LAT, LON),
    ).resolves.toBe(1.0);
  });

  it('returns 1.0 when demand is below the threshold', async () => {
    const service = new SurgeService(
      redisMock() as never,
      geoMock(10) as never, // supply 10
      config(),
    );
    // Seed demand via the real counter path.
    for (let i = 0; i < 4; i++) {
      await service.recordDemand('Delhi', LAT, LON);
    }

    await expect(
      service.getMultiplier('Delhi', LAT, LON),
    ).resolves.toBe(1.0); // ratio 0.4
  });

  it('steps the multiplier up when demand exceeds supply', async () => {
    const redis = redisMock();
    const service = new SurgeService(redis as never, geoMock(10) as never, config());
    for (let i = 0; i < 30; i++) {
      await service.recordDemand('Delhi', LAT, LON);
    }

    // ratio 3.0 → 1 + ceil(1.5/0.25)×0.25 = 2.5
    await expect(service.getMultiplier('Delhi', LAT, LON)).resolves.toBe(2.5);
  });

  it('caps the multiplier at the configured maximum', async () => {
    const redis = redisMock();
    const service = new SurgeService(redis as never, geoMock(1) as never, config());
    for (let i = 0; i < 999; i++) {
      await service.recordDemand('Delhi', LAT, LON);
    }

    await expect(service.getMultiplier('Delhi', LAT, LON)).resolves.toBe(2.5);
  });

  it('serves a cached multiplier without recomputing supply', async () => {
    const redis = redisMock();
    const geo = geoMock(3);
    const service = new SurgeService(redis as never, geo as never, config());
    await redis.set(multiplierKey(service), '2.25');

    await expect(
      service.getMultiplier('Delhi', LAT, LON),
    ).resolves.toBe(2.25);
    expect(geo.findNearbyDriverIds).not.toHaveBeenCalled();
  });

  it('rounds multipliers to 2 decimals', async () => {
    const redis = redisMock();
    const service = new SurgeService(redis as never, geoMock(10) as never, config());
    for (let i = 0; i < 16; i++) {
      await service.recordDemand('Delhi', LAT, LON);
    }

    // ratio 1.6 → 1 + ceil(0.1/0.25)×0.25 = 1.25
    await expect(service.getMultiplier('Delhi', LAT, LON)).resolves.toBe(1.25);
  });

  it('scopes demand keys per H3 cell (no city-wide bleed)', async () => {
    const redis = redisMock();
    const service = new SurgeService(redis as never, geoMock(5) as never, config());
    await service.recordDemand('Delhi', LAT, LON);

    expect(redis.incr).toHaveBeenCalledWith(demandKey(service));
  });
});
