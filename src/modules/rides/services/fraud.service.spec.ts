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

function rideRepoMock(count: jest.Mock) {
  return { count };
}

describe('FraudService', () => {
  it('skips all guards when disabled', async () => {
    const count = jest.fn();
    const redis = redisMock();
    const service = new FraudService(
      rideRepoMock(count) as never,
      redis as never,
      config({ fraud: { enabled: false } }),
    );

    await service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi');

    expect(count).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('blocks when ride velocity per hour is at the cap', async () => {
    const redis = redisMock();
    const service = new FraudService(
      rideRepoMock(jest.fn().mockResolvedValue(5)) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a ride below the velocity cap', async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(4) // velocity
      .mockResolvedValueOnce(0); // concurrency
    const redis = redisMock();
    const service = new FraudService(
      rideRepoMock(count) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).resolves.toBeUndefined();
  });

  it('blocks too many concurrent active rides', async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(1) // velocity
      .mockResolvedValueOnce(2); // concurrency
    const redis = redisMock();
    const service = new FraudService(
      rideRepoMock(count) as never,
      redis as never,
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
      rideRepoMock(jest.fn().mockResolvedValue(0)) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).rejects.toThrow('Repeated ride requests from the same location');
  });

  it('fails open when Redis throws (never blocks genuine riders)', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const redis = redisMock();
    redis.get.mockRejectedValue(new Error('redis down'));
    const service = new FraudService(
      rideRepoMock(count) as never,
      redis as never,
      config(),
    );

    await expect(
      service.guardRideRequest('rider-1', 28.7, 77.1, 'Delhi'),
    ).resolves.toBeUndefined();
  });
});
