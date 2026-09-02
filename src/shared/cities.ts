import type { RideTypeValue } from '../shared/types/common';

/**
 * Canonical service-city centers — single source of truth for geo-sharding
 * the driver index (`drivers:geo:{city}`) and for fare seeding parity.
 * Mirrors the seed's CITIES table; keep both in sync when adding a city.
 */
export interface ServiceCity {
  name: string;
  lat: number;
  lon: number;
  /**
   * GST state code (the 2-letter code, matching the first two digits of a
   * GSTIN). Required for invoicing: place of supply is a STATE, not a city, and
   * comparing a city name against a state code silently classifies every
   * intra-state ride as inter-state — which files the whole tax return under
   * IGST instead of CGST+SGST.
   */
  stateCode: string;
  /** Full state name printed on the invoice. */
  stateName: string;
}

export const SERVICE_CITY_CENTERS: ServiceCity[] = [
  {
    name: 'Delhi',
    lat: 28.6139,
    lon: 77.209,
    stateCode: 'DL',
    stateName: 'Delhi',
  },
  {
    name: 'Noida',
    lat: 28.5355,
    lon: 77.391,
    stateCode: 'UP',
    stateName: 'Uttar Pradesh',
  },
  {
    name: 'Gurugram',
    lat: 28.4595,
    lon: 77.0266,
    stateCode: 'HR',
    stateName: 'Haryana',
  },
  {
    name: 'Bangalore',
    lat: 12.9716,
    lon: 77.5946,
    stateCode: 'KA',
    stateName: 'Karnataka',
  },
  {
    name: 'Mumbai',
    lat: 19.076,
    lon: 72.8777,
    stateCode: 'MH',
    stateName: 'Maharashtra',
  },
  {
    name: 'Hyderabad',
    lat: 17.385,
    lon: 78.4867,
    stateCode: 'TS',
    stateName: 'Telangana',
  },
  {
    name: 'Pune',
    lat: 18.5204,
    lon: 73.8567,
    stateCode: 'MH',
    stateName: 'Maharashtra',
  },
  {
    name: 'Chennai',
    lat: 13.0827,
    lon: 80.2707,
    stateCode: 'TN',
    stateName: 'Tamil Nadu',
  },
];

/**
 * City name → GST state code. Returns undefined for an unknown city so callers
 * must decide explicitly rather than silently defaulting to a tax treatment.
 */
export function stateCodeForCity(city: string): string | undefined {
  const needle = city.trim().toLowerCase();
  return SERVICE_CITY_CENTERS.find((c) => c.name.toLowerCase() === needle)
    ?.stateCode;
}

/** Nearest service city to a coordinate — cheap haversine over 8 centers. */
export function nearestServiceCity(lat: number, lon: number): ServiceCity {
  let best = SERVICE_CITY_CENTERS[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of SERVICE_CITY_CENTERS) {
    const dLat = ((c.lat - lat) * Math.PI) / 180;
    const dLon = ((c.lon - lon) * Math.PI) / 180;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat * Math.PI) / 180) *
        Math.cos((c.lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    const km = 12742 * Math.asin(Math.sqrt(s));
    if (km < bestD) {
      bestD = km;
      best = c;
    }
  }
  return best;
}

export type { RideTypeValue };
