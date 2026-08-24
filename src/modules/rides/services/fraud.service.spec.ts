import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FraudService } from './fraud.service';

function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService(
    Object.assign(
      {
        fraud: {
          enabled: true,
          maxRidesPerHour: 5,
          maxConcurrentActiveRides: 2,
          duplicateWindowMinutes: 10,
          maxDuplicateRequests: 3,
        },
      },
      overrides,
    ),
  );
}

function redisMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

/**
 * Drizzle mock: db.select({value}).from().where() resolves to rows queued
 * in order — first call = velocity count, second = concurrency count.
 * The last value repeats when more queries than values are issued.
 */
function drizzleMock(counts: number[]) {
  const queue = [...counts];
  const next = () => [{ value: queue.length > 1 ? queue.shift() : queue[0] }];
  const end = () => Promise.resolve(next());
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => end()),
  };
  return { select: jest.fn(() => chain) };
}

describe('FraudService', () => {
  it('skips all guards when disabled', async () => {
    const redis = redisMock();
    const db = drizzleMock([]);
    const service = new FraudService(
      db as never,
      redis as never,
      config({ fraud: { enabled: false } }),
    );

    await service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi');

    expect(db.select).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('blocks when ride velocity per hour is at the cap', async () => {
    const service = new FraudService(
      drizzleMock([5]) as never,
      redisMock() as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a ride below the velocity cap', async () => {
    const service = new FraudService(
      drizzleMock([4, 0]) as never, // velocity 4 < cap, concurrency 0
      redisMock() as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).resolves.toBeUndefined();
  });

  it('blocks too many concurrent active rides', async () => {
    const service = new FraudService(
      drizzleMock([1, 2]) as never, // velocity ok, concurrency at cap
      redisMock() as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).rejects.toThrow('Too many active rides');
  });

  it('blocks repeated requests from the same pickup point', async () => {
    const redis = redisMock();
    redis.get.mockResolvedValue('3'); // 3 previous requests in window
    const service = new FraudService(
      drizzleMock([0]) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).rejects.toThrow('Repeated ride requests from the same location');
  });

  it('fails open when Redis throws (never blocks genuine riders)', async () => {
    const redis = redisMock();
    redis.get.mockRejectedValue(new Error('redis down'));
    const service = new FraudService(
      drizzleMock([0]) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).resolves.toBeUndefined();
  });
});
