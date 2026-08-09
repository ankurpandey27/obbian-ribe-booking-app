import { GeoService, DRIVERS_GEO_KEY } from './geo.service';

function redisMock() {
  return {
    geoadd: jest.fn().mockResolvedValue(1),
    zrem: jest.fn().mockResolvedValue(1),
    georadius: jest.fn().mockResolvedValue(['driver-1', 'driver-2']),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
  };
}

function buildService(redis: ReturnType<typeof redisMock>) {
  return new GeoService(redis as never);
}

describe('GeoService', () => {
  it('stores driver positions with longitude FIRST (Redis order)', async () => {
    const redis = redisMock();
    const service = buildService(redis);

    await service.upsertDriverPosition('driver-1', 77.1025, 28.7041);

    expect(redis.geoadd).toHaveBeenCalledWith(
      DRIVERS_GEO_KEY,
      77.1025,
      28.7041,
      'driver-1',
    );
  });

  it('removes a driver from the geo index on logout', async () => {
    const redis = redisMock();
    const service = buildService(redis);

    await service.removeDriverPosition('driver-1');

    expect(redis.zrem).toHaveBeenCalledWith(DRIVERS_GEO_KEY, 'driver-1');
  });

  it('queries nearby drivers radius-first with ASC ordering', async () => {
    const redis = redisMock();
    const service = buildService(redis);

    const drivers = await service.findNearbyDriverIds(77.1025, 28.7041, 8, 10);

    expect(redis.georadius).toHaveBeenCalledWith(
      DRIVERS_GEO_KEY,
      77.1025,
      28.7041,
      8,
      'km',
      'COUNT',
      10,
      'ASC',
    );
    expect(drivers).toEqual(['driver-1', 'driver-2']);
  });

  it('returns null when no cached position exists', async () => {
    const redis = redisMock();
    redis.get.mockResolvedValue(null);
    const service = buildService(redis);

    await expect(service.getDriverPosition('driver-1')).resolves.toBeNull();
  });

  it('parses a cached position with timestamp', async () => {
    const redis = redisMock();
    redis.get.mockResolvedValue(
      JSON.stringify({ lat: 28.7041, lon: 77.1025, timestamp: 1700000000 }),
    );
    const service = buildService(redis);

    await expect(service.getDriverPosition('driver-1')).resolves.toEqual({
      lat: 28.7041,
      lon: 77.1025,
      timestamp: 1700000000,
    });
  });

  it('caches driver positions for the REST tracking fallback', async () => {
    const redis = redisMock();
    const service = buildService(redis);

    await service.cacheDriverPosition('driver-1', 28.7041, 77.1025, 1700000000);

    expect(redis.setex).toHaveBeenCalledWith(
      'driver:driver-1:location',
      300,
      JSON.stringify({ lat: 28.7041, lon: 77.1025, timestamp: 1700000000 }),
    );
  });
});
