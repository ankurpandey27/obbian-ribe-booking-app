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
    opts: { trafficAware?: boolean } = {},
  ): Promise<RouteInfo> {
    const key = `route:${pickupLat.toFixed(5)},${pickupLon.toFixed(5)}:${dropoffLat.toFixed(5)},${dropoffLon.toFixed(5)}`;
    const cached = await this.redis.get(key);
    if (cached && !opts.trafficAware) return JSON.parse(cached) as RouteInfo;

    const route = await (this.provider === 'google'
      ? this.googleRoute(
          pickupLat,
          pickupLon,
          dropoffLat,
          dropoffLon,
          opts.trafficAware,
        )
      : this.osrmRoute(pickupLat, pickupLon, dropoffLat, dropoffLon));

    // Only cache non-traffic routes (traffic varies minute-to-minute)
    if (!opts.trafficAware) {
      await this.redis
        .set(key, JSON.stringify(route), 'EX', CACHE_TTL_ROUTE)
        .catch(() => undefined);
    }
    return route;
  }

  /**
   * Reroute an active ride when traffic/incident degrades ETA beyond a
   * threshold. Returns the new route, or null if the current route is still
   * acceptable (no reroute needed).
   */
  async reroute(
    rideId: string,
    currentLat: number,
    currentLon: number,
    destLat: number,
    destLon: number,
    currentEtaMin: number,
    rerouteThresholdPct = 25,
  ): Promise<{ route: RouteInfo; reason: string } | null> {
    // Get live-traffic ETA from current position to destination
    const live = await this.getRoute(currentLat, currentLon, destLat, destLon, {
      trafficAware: true,
    });

    // Reroute if live ETA exceeds the planned ETA by more than the threshold
    const threshold = currentEtaMin * (1 + rerouteThresholdPct / 100);
    if (live.durationMin > threshold) {
      return {
        route: live,
        reason: `ETA degraded: planned ${currentEtaMin.toFixed(0)}min, live ${live.durationMin.toFixed(0)}min (threshold ${rerouteThresholdPct}%)`,
      };
    }
    return null;
  }

  /** Correct Google polyline5 decoder. Returns [] on any error. */
  private decodePolyline(
    polyline: string,
  ): Array<{ lat: number; lon: number }> {
    try {
      const points: Array<{ lat: number; lon: number }> = [];
      let index = 0,
        lat = 0,
        lng = 0;
      while (index < polyline.length) {
        let result = 0,
          shift = 0,
          b: number;
        do {
          b = polyline.charCodeAt(index++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        lat += result & 1 ? ~(result >> 1) : result >> 1;
        result = shift = 0;
        do {
          b = polyline.charCodeAt(index++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        lng += result & 1 ? ~(result >> 1) : result >> 1;
        points.push({ lat: lat * 1e-5, lon: lng * 1e-5 });
      }
      return points;
    } catch {
      return [];
    }
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    trafficAware = false,
  ): Promise<RouteInfo> {
    if (!this.googleApiKey)
      throw new ServiceUnavailableException(
        'Google Maps API key not configured',
      );
    const trafficModel = trafficAware
      ? '&trafficModel=best_guess&departure_time=now'
      : '';
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${pLat},${pLon}&destination=${dLat},${dLon}&mode=driving&alternatives=false${trafficModel}&key=${this.googleApiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      status: string;
      routes?: Array<{
        legs?: Array<{
          distance?: { value: number };
          duration?: { value: number };
          duration_in_traffic?: { value: number };
        }>;
        overview_polyline?: { points: string };
      }>;
    };
    if (data.status !== 'OK' || !data.routes?.[0]) {
      throw new ServiceUnavailableException('Route not found');
    }
    const leg = data.routes[0].legs?.[0];
    // Prefer live traffic duration when available
    const durationSec = trafficAware
      ? (leg?.duration_in_traffic?.value ?? leg?.duration?.value ?? 0)
      : (leg?.duration?.value ?? 0);
    return {
      distanceKm: (leg?.distance?.value ?? 0) / 1000,
      durationMin: durationSec / 60,
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

  /**
   * Check if a route corridor intersects any active incident area. Uses a
   * correct polyline5 decoder and checks sampled points against each incident's
   * radius. Returns true if any point falls within any incident area.
   */
  checkIncidentOnRoute(
    polyline: string | undefined,
    activeIncidentAreas: Array<{ lat: number; lon: number; radiusM: number }>,
  ): boolean {
    if (!polyline || activeIncidentAreas.length === 0) return false;
    const points = this.decodePolyline(polyline);
    for (let i = 0; i < points.length; i += 3) {
      for (const area of activeIncidentAreas) {
        const d = this.haversine(
          points[i].lat,
          points[i].lon,
          area.lat,
          area.lon,
        );
        if (d * 1000 <= area.radiusM) return true;
      }
    }
    return false;
  }
}
