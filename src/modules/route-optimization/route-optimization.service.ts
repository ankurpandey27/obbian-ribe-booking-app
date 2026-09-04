import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { incidentAreas } from '../../common/database/schema';
import { MapsService } from '../maps/maps.service';

export interface RouteCheckResult {
  needsReroute: boolean;
  reason?: string;
  route?: { distanceKm: number; durationMin: number; polyline?: string };
  advisory?: { mode: string; note: string };
}

@Injectable()
export class RouteOptimizationService {
  private readonly logger = new Logger(RouteOptimizationService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly maps: MapsService,
  ) {}

  /**
   * Check an active ride's route for traffic degradation and incident
   * intersections. Called periodically by the tracking worker for IN_RIDE
   * rides. Returns a reroute recommendation if needed.
   */
  async checkActiveRoute(input: {
    rideId: string;
    currentLat: number;
    currentLon: number;
    destLat: number;
    destLon: number;
    plannedEtaMin: number;
  }): Promise<RouteCheckResult> {
    // 1. Check for incidents on the planned corridor
    const activeAreas = await this.getActiveIncidentAreas();
    const hasIncident = this.maps.checkIncidentOnRoute(
      undefined, // would pass the planned polyline in production
      activeAreas.map((a) => ({ lat: a.lat, lon: a.lon, radiusM: a.radiusM })),
    );

    if (hasIncident) {
      // Find a diversion route that avoids the incident area
      const diversion = await this.maps.getRoute(
        input.currentLat,
        input.currentLon,
        input.destLat,
        input.destLon,
        { trafficAware: true },
      );
      return {
        needsReroute: true,
        reason: 'Incident on route — diverting',
        route: diversion,
        advisory: {
          mode: 'ROAD',
          note: 'Rerouting around an incident ahead. Your ETA may change.',
        },
      };
    }

    // 2. Check for traffic degradation
    const reroute = await this.maps.reroute(
      input.rideId,
      input.currentLat,
      input.currentLon,
      input.destLat,
      input.destLon,
      input.plannedEtaMin,
    );

    if (reroute) {
      return {
        needsReroute: true,
        reason: reroute.reason,
        route: reroute.route,
      };
    }

    return { needsReroute: false };
  }

  /** Get all active incident areas. */
  async getActiveIncidentAreas() {
    const now = new Date();
    return this.db
      .select()
      .from(incidentAreas)
      .where(
        and(
          eq(incidentAreas.isActive, true),
          or(isNull(incidentAreas.expiresAt), gt(incidentAreas.expiresAt, now)),
        ),
      );
  }

  /** Create an incident area (ops). */
  async createIncidentArea(input: {
    incidentId?: string;
    areaType?: string;
    lat: number;
    lon: number;
    radiusM?: number;
    reason?: string;
    expiresAt?: Date;
  }) {
    const [row] = await this.db
      .insert(incidentAreas)
      .values({
        incidentId: input.incidentId ?? null,
        areaType: input.areaType ?? 'RESTRICTED',
        lat: input.lat,
        lon: input.lon,
        radiusM: input.radiusM ?? 500,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return row;
  }

  /**
   * Multi-modal hint: if road ETA exceeds a threshold, suggest an alternative
   * mode (e.g., metro). Config-driven; stubs the transit source behind an
   * interface so no hard external dependency exists at launch.
   */
  getMultiModalHint(input: {
    originLat: number;
    originLon: number;
    destLat: number;
    destLon: number;
    roadEtaMin: number;
    thresholdMin?: number;
  }): { mode: string; note: string } | null {
    const threshold = input.thresholdMin ?? 45; // config-driven
    if (input.roadEtaMin < threshold) return null;

    // Stub: in production, query a transit provider. For now, return an
    // advisory that FE can render.
    return {
      mode: 'METRO',
      note: `This trip is ${Math.round(input.roadEtaMin)}min by road. The metro may be faster for part of this route.`,
    };
  }
}
