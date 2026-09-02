import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { RouteInfo } from '../../shared/types/common';

const CACHE_TTL_ROUTE = 30; // seconds
const CACHE_TTL_GEOCODE = 86400; // 24h for addresses

export interface PlaceSuggestion {
  placeId: string;
  address: string;
  lat: number;
  lon: number;
}

/**
 * MapsService — server-side proxy for map providers.
 * API key NEVER ships to clients (no key leakage, single billing point).
 * Provider: google | osrm. Caches routes (30s) and geocodes (24h) in Redis.
 */
@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly provider: string;
  private readonly googleApiKey?: string;
  private readonly osrmBaseUrl: string;

  constructor(
    config: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.provider = config.get<string>('maps.provider', 'google');
    this.googleApiKey = config.get<string>('maps.googleApiKey');
    this.osrmBaseUrl = config.get<string>(
      'maps.osrmBaseUrl',
      'http://router.project-osrm.org',
    );
  }

  async autocomplete(query: string): Promise<PlaceSuggestion[]> {
    if (this.provider === 'google') {
      return this.googleAutocomplete(query);
    }
    throw new ServiceUnavailableException(
      'Autocomplete requires google provider',
    );
  }

  async reverseGeocode(lat: number, lon: number): Promise<string> {
    const cacheKey = `geocode:${lat.toFixed(5)},${lon.toFixed(5)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const address = await this.googleReverseGeocode(lat, lon);
    await this.redis
      .set(cacheKey, address, 'EX', CACHE_TTL_GEOCODE)
      .catch(() => undefined);
    return address;
  }

  /** Road distance + duration between two points (NOT haversine). */
  async getRoute(
    pickupLat: number,
    pickupLon: number,
    dropoffLat: number,
    dropoffLon: number,
  ): Promise<RouteInfo> {
    const key = `route:${pickupLat.toFixed(5)},${pickupLon.toFixed(5)}:${dropoffLat.toFixed(5)},${dropoffLon.toFixed(5)}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as RouteInfo;

    const route = await (this.provider === 'google'
      ? this.googleRoute(pickupLat, pickupLon, dropoffLat, dropoffLon)
      : this.osrmRoute(pickupLat, pickupLon, dropoffLat, dropoffLon));

    await this.redis
      .set(key, JSON.stringify(route), 'EX', CACHE_TTL_ROUTE)
      .catch(() => undefined);
    return route;
  }

  /* ------------------------------ providers ------------------------------ */

  private async googleAutocomplete(query: string): Promise<PlaceSuggestion[]> {
    if (!this.googleApiKey)
      throw new ServiceUnavailableException(
        'Google Maps API key not configured',
      );
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&components=country:in&key=${this.googleApiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      predictions?: Array<{ place_id: string; description: string }>;
      status: string;
    };
    if (data.status !== 'OK') return [];

    return Promise.all(
      data.predictions?.slice(0, 5).map(async (p) => {
        const { lat, lon } = await this.googlePlaceDetails(p.place_id);
        return { placeId: p.place_id, address: p.description, lat, lon };
      }) ?? [],
    );
  }

  private async googlePlaceDetails(
    placeId: string,
  ): Promise<{ lat: number; lon: number }> {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry&key=${this.googleApiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      result?: { geometry?: { location?: { lat: number; lng: number } } };
    };
    const loc = data.result?.geometry?.location;
    return loc ? { lat: loc.lat, lon: loc.lng } : { lat: 0, lon: 0 };
  }

  private async googleReverseGeocode(
    lat: number,
    lon: number,
  ): Promise<string> {
    if (!this.googleApiKey)
      throw new ServiceUnavailableException(
        'Google Maps API key not configured',
      );
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&result_type=street_address|route|sublocality_level_1&key=${this.googleApiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      results?: Array<{ formatted_address: string }>;
    };
    return (
      data.results?.[0]?.formatted_address ??
      `${lat.toFixed(5)}, ${lon.toFixed(5)}`
    );
  }

  private async googleRoute(
    pLat: number,
    pLon: number,
    dLat: number,
    dLon: number,
  ): Promise<RouteInfo> {
    if (!this.googleApiKey)
      throw new ServiceUnavailableException(
        'Google Maps API key not configured',
      );
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${pLat},${pLon}&destination=${dLat},${dLon}&mode=driving&alternatives=false&key=${this.googleApiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status: string;
      routes?: Array<{
        legs?: Array<{
          distance?: { value: number };
          duration?: { value: number };
        }>;
        overview_polyline?: { points: string };
      }>;
    };
    if (data.status !== 'OK' || !data.routes?.[0]) {
      throw new ServiceUnavailableException('Route not found');
    }
    const leg = data.routes[0].legs?.[0];
    return {
      distanceKm: (leg?.distance?.value ?? 0) / 1000,
      durationMin: (leg?.duration?.value ?? 0) / 60,
      polyline: data.routes[0].overview_polyline?.points,
    };
  }

  private async osrmRoute(
    pLat: number,
    pLon: number,
    dLat: number,
    dLon: number,
  ): Promise<RouteInfo> {
    const url = `${this.osrmBaseUrl}/route/v1/driving/${pLon},${pLat};${dLon},${dLat}?overview=full&geometries=polyline`;
    const res = await fetch(url);
    const raw = await res.text();
    if (!res.ok || raw.length === 0) {
      this.logger.warn(
        `OSRM HTTP ${res.status} for ${url}: ${raw.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException('Route not found');
    }
    const data = JSON.parse(raw) as {
      code: string;
      routes?: Array<{ distance: number; duration: number; geometry: string }>;
    };
    if (data.code !== 'Ok' || !data.routes?.[0]) {
      throw new ServiceUnavailableException('Route not found');
    }
    const route = data.routes[0];
    return {
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      polyline: route.geometry,
    };
  }
}
