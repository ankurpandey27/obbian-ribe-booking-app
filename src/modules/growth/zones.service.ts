import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { CreateZoneDto } from './dto/growth.dto';

export interface ResolvedZone {
  id: string;
  name: string;
  slug: string;
  areaType: string;
  city: string;
  surchargePaise: number;
  minSurgeMultiplier: number | null;
  isRestricted: boolean;
  restrictionMessage: string | null;
  priority: number;
}

@Injectable()
export class ZonesService {
  private readonly enabled: boolean;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('zones.enabled', true);
  }

  async create(dto: CreateZoneDto) {
    this.assertPolygon(dto.boundary);
    const [row] = await this.db.execute(sql`
      INSERT INTO areas
        ("name", "slug", "areaType", "city", "boundary", "surchargePaise",
         "minSurgeMultiplier", "isRestricted", "restrictionMessage")
      VALUES
        (${dto.name}, ${dto.slug}, ${dto.areaType}::area_type, ${dto.city},
         ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(dto.boundary)}), 4326)::geography,
         ${dto.surchargePaise ?? 0}, ${dto.minSurgeMultiplier ?? null},
         ${dto.isRestricted ?? false}, ${dto.restrictionMessage ?? null})
      RETURNING id, "name", "slug", "areaType", "city", "surchargePaise",
        "minSurgeMultiplier", "isRestricted", "restrictionMessage", "priority"
    `);
    return row;
  }

  async resolvePoint(lat: number, lon: number): Promise<ResolvedZone[]> {
    if (!this.enabled) return [];
    const result = await this.db.execute(sql`
      SELECT id, "name", "slug", "areaType", "city", "surchargePaise",
        "minSurgeMultiplier", "isRestricted", "restrictionMessage", priority
      FROM areas
      WHERE "isActive" = true
        AND ST_Covers("boundary", ST_SetSRID(ST_Point(${lon}, ${lat}), 4326)::geography)
      ORDER BY priority DESC, "createdAt" ASC
      LIMIT 20
    `);
    return result.rows;
  }

  async list(city?: string) {
    const result = city
      ? await this.db.execute(sql`
          SELECT id, "name", "slug", "areaType", "city", "surchargePaise",
            "minSurgeMultiplier", "isRestricted", "restrictionMessage", priority
          FROM areas WHERE "isActive" = true AND "city" = ${city}
          ORDER BY priority DESC, "name" ASC LIMIT 200
        `)
      : await this.db.execute(sql`
          SELECT id, "name", "slug", "areaType", "city", "surchargePaise",
            "minSurgeMultiplier", "isRestricted", "restrictionMessage", priority
          FROM areas WHERE "isActive" = true
          ORDER BY priority DESC, "name" ASC LIMIT 200
        `);
    return result.rows;
  }

  private assertPolygon(value: Record<string, unknown>): void {
    if (value['type'] !== 'Polygon' || !Array.isArray(value['coordinates'])) {
      throw new BadRequestException('boundary must be a GeoJSON Polygon');
    }
  }
}
