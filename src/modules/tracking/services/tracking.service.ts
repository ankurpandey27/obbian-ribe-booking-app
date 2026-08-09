import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ride } from '../../rides/entities/ride.entity';
import { GeoService } from '../../../common/redis/geo.service';
import { MapsService } from '../../maps/services/maps.service';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { Redis } from 'ioredis';
import { RouteInfo } from '../../../shared/types/common';

const ETA_CACHE_TTL = 30; // seconds

/**
 * TrackingService — REST fallback for the socket stream (poor networks).
 * Rider polls GET /rides/:id/tracking when the socket drops; returns
 * the driver's latest position + route + ETA.
 */
@Injectable()
export class TrackingService {
  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    private readonly geo: GeoService,
    private readonly maps: MapsService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async getTracking(rideId: string) {
    const ride = await this.rideRepo.findOneBy({ id: rideId });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);

    const driverPos = ride.driverId
      ? await this.geo.getDriverPosition(ride.driverId)
      : null;

    const eta = await this.getEta(ride);
    const route =
      ride.status === 'IN_PROGRESS' ||
      ride.status === 'ACCEPTED' ||
      ride.status === 'ARRIVED'
        ? await this.maps
            .getRoute(
              ride.pickupLat,
              ride.pickupLon,
              ride.dropoffLat,
              ride.dropoffLon,
            )
            .catch(() => null)
        : null;

    return {
      rideId,
      status: ride.status,
      driver: driverPos
        ? {
            lat: driverPos.lat,
            lon: driverPos.lon,
            lastUpdate: driverPos.timestamp,
          }
        : null,
      pickup: { lat: ride.pickupLat, lon: ride.pickupLon },
      dropoff: { lat: ride.dropoffLat, lon: ride.dropoffLon },
      route,
      eta,
    };
  }

  async getEta(
    ride: Ride,
  ): Promise<{ etaMinutes: number; distanceKm: number }> {
    const cacheKey = `eta:${ride.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const driverPos = ride.driverId
      ? await this.geo.getDriverPosition(ride.driverId)
      : null;

    if (!driverPos) {
      return {
        etaMinutes: ride.durationMin,
        distanceKm: Number(ride.distanceKm),
      };
    }

    const origin =
      ride.status === 'IN_PROGRESS'
        ? driverPos
        : { lat: driverPos.lat, lon: driverPos.lon };
    const dest =
      ride.status === 'IN_PROGRESS'
        ? { lat: ride.dropoffLat, lon: ride.dropoffLon }
        : { lat: ride.pickupLat, lon: ride.pickupLon };

    const route = await this.maps
      .getRoute(origin.lat, origin.lon, dest.lat, dest.lon)
      .catch((): RouteInfo | null => null);

    const result = route
      ? {
          etaMinutes: Math.max(1, Math.round(route.durationMin)),
          distanceKm: route.distanceKm,
        }
      : { etaMinutes: ride.durationMin, distanceKm: Number(ride.distanceKm) };

    await this.redis
      .set(cacheKey, JSON.stringify(result), 'EX', ETA_CACHE_TTL)
      .catch(() => undefined);
    return result;
  }
}
