import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  catalogVersions,
  rideCategories,
  rideCategoryCities,
  services,
} from '../../common/database/schema';

export interface CatalogLocale {
  locale: string;
  fallback: string[];
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  /**
   * Get the full catalog for a city + locale. Single read endpoint that
   * drives the whole FE. Cache-busted by catalogVersion.
   */
  async getCatalog(city: string, locale: string) {
    const version = await this.getVersion('global');

    const rows = await this.db
      .select({
        serviceId: services.id,
        serviceCode: services.code,
        serviceDisplayName: services.displayName,
        serviceIconUrl: services.iconUrl,
        serviceSortOrder: services.sortOrder,
        categoryId: rideCategories.id,
        categoryCode: rideCategories.code,
        categoryDisplayName: rideCategories.displayName,
        categoryDescription: rideCategories.description,
        categoryIconUrl: rideCategories.iconUrl,
        categoryThumbnailUrl: rideCategories.thumbnailUrl,
        categoryCapacity: rideCategories.capacity,
        categorySortOrder: rideCategories.sortOrder,
        categoryFlags: rideCategories.flags,
        categoryVehicleClass: rideCategories.vehicleClass,
        categoryEtaFactor: rideCategories.etaFactor,
        cityAvailable: rideCategoryCities.isAvailable,
        citySortOrder: rideCategoryCities.sortOrder,
      })
      .from(services)
      .innerJoin(rideCategories, eq(rideCategories.serviceId, services.id))
      .innerJoin(
        rideCategoryCities,
        and(
          eq(rideCategoryCities.rideCategoryId, rideCategories.id),
          eq(rideCategoryCities.city, city),
          eq(rideCategoryCities.isAvailable, true),
        ),
      )
      .where(
        and(eq(services.isActive, true), eq(rideCategories.isActive, true)),
      )
      .orderBy(
        asc(services.sortOrder),
        asc(
          sql`COALESCE(${rideCategoryCities.sortOrder}, ${rideCategories.sortOrder})`,
        ),
      );

    // Group by service
    const serviceMap = new Map<string, any>();
    for (const row of rows) {
      if (!serviceMap.has(row.serviceCode)) {
        serviceMap.set(row.serviceCode, {
          code: row.serviceCode,
          displayName: this.resolveLocale(row.serviceDisplayName, locale),
          iconUrl: row.serviceIconUrl,
          sortOrder: row.serviceSortOrder,
          categories: [],
        });
      }
      const service = serviceMap.get(row.serviceCode);
      service.categories.push({
        code: row.categoryCode,
        displayName: this.resolveLocale(row.categoryDisplayName, locale),
        description: this.resolveLocale(row.categoryDescription ?? {}, locale),
        iconUrl: row.categoryIconUrl,
        thumbnailUrl: row.categoryThumbnailUrl,
        capacity: row.categoryCapacity,
        flags: row.categoryFlags ?? {},
        vehicleClass: row.categoryVehicleClass,
        etaFactor: Number(row.categoryEtaFactor),
        available: row.cityAvailable,
        sortOrder: row.citySortOrder ?? row.categorySortOrder,
      });
    }

    return {
      catalogVersion: version,
      city,
      locale,
      services: Array.from(serviceMap.values()),
    };
  }

  /** Resolve a JSONB locale map to the best available locale. */
  private resolveLocale(
    map: Record<string, string> | null,
    locale: string,
  ): string {
    if (!map) return '';
    if (map[locale]) return map[locale];
    // Fallback chain: te-IN → hi-IN → en-IN → first available
    const fallback =
      locale === 'te-IN'
        ? ['hi-IN', 'en-IN']
        : locale === 'hi-IN'
          ? ['en-IN']
          : [];
    for (const fb of fallback) {
      if (map[fb]) return map[fb];
    }
    return Object.values(map)[0] ?? '';
  }

  /** Get a single category by code (used by pricing/matching validation). */
  async getCategory(code: string) {
    const [row] = await this.db
      .select()
      .from(rideCategories)
      .where(
        and(eq(rideCategories.code, code), eq(rideCategories.isActive, true)),
      )
      .limit(1);
    return row ?? null;
  }

  /** Get all active category codes (for runtime validation). */
  async getActiveCategoryCodes(city?: string): Promise<string[]> {
    if (city) {
      const rows = await this.db
        .select({ code: rideCategories.code })
        .from(rideCategories)
        .innerJoin(
          rideCategoryCities,
          and(
            eq(rideCategoryCities.rideCategoryId, rideCategories.id),
            eq(rideCategoryCities.city, city),
            eq(rideCategoryCities.isAvailable, true),
          ),
        )
        .where(eq(rideCategories.isActive, true));
      return rows.map((r) => r.code);
    }
    const rows = await this.db
      .select({ code: rideCategories.code })
      .from(rideCategories)
      .where(eq(rideCategories.isActive, true));
    return rows.map((r) => r.code);
  }

  /** Get eta factor for a category (replaces hardcoded Record<RideTypeValue, number>). */
  async getEtaFactor(code: string): Promise<number> {
    const [row] = await this.db
      .select({ etaFactor: rideCategories.etaFactor })
      .from(rideCategories)
      .where(eq(rideCategories.code, code))
      .limit(1);
    return row ? Number(row.etaFactor) : 1.0;
  }

  // ── Admin: catalog version ──────────────────────────────────────────────
  async getVersion(scope: string): Promise<number> {
    const [row] = await this.db
      .select({ version: catalogVersions.version })
      .from(catalogVersions)
      .where(eq(catalogVersions.scope, scope))
      .limit(1);
    return row?.version ?? 1;
  }

  /** Bump the catalog version (call after any catalog write). */
  async bumpVersion(scope = 'global'): Promise<number> {
    const result = await this.db
      .insert(catalogVersions)
      .values({ scope, version: 1 })
      .onConflictDoUpdate({
        target: catalogVersions.scope,
        set: {
          version: sql`${catalogVersions.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ version: catalogVersions.version });
    const version = result[0]?.version ?? 1;
    this.logger.log(`catalog version bumped to ${version} (scope=${scope})`);
    return version;
  }

  // ── Admin: services CRUD ────────────────────────────────────────────────
  async createService(data: {
    code: string;
    displayName: Record<string, string>;
    iconUrl?: string;
    sortOrder?: number;
    isActive?: boolean;
  }) {
    const [row] = await this.db
      .insert(services)
      .values({
        code: data.code,
        displayName: data.displayName,
        iconUrl: data.iconUrl,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive ?? true,
      })
      .returning();
    await this.bumpVersion();
    return row;
  }

  async updateService(
    id: string,
    data: Partial<{
      displayName: Record<string, string>;
      iconUrl: string;
      sortOrder: number;
      isActive: boolean;
    }>,
  ) {
    const [row] = await this.db
      .update(services)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(services.id, id))
      .returning();
    if (!row) throw new NotFoundException(`Service ${id} not found`);
    await this.bumpVersion();
    return row;
  }

  async deleteService(id: string) {
    await this.db.delete(services).where(eq(services.id, id));
    await this.bumpVersion();
  }

  // ── Admin: ride categories CRUD ─────────────────────────────────────────
  async createCategory(data: {
    code: string;
    serviceId: string;
    displayName: Record<string, string>;
    description?: Record<string, string>;
    iconUrl?: string;
    thumbnailUrl?: string;
    capacity?: number;
    sortOrder?: number;
    isActive?: boolean;
    flags?: Record<string, boolean>;
    vehicleClass?: string;
    etaFactor?: number;
  }) {
    const [row] = await this.db
      .insert(rideCategories)
      .values({
        code: data.code,
        serviceId: data.serviceId,
        displayName: data.displayName,
        description: data.description ?? {},
        iconUrl: data.iconUrl,
        thumbnailUrl: data.thumbnailUrl,
        capacity: data.capacity ?? 4,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive ?? true,
        flags: data.flags ?? {},
        vehicleClass: data.vehicleClass,
        etaFactor: data.etaFactor ?? 1.0,
      })
      .returning();
    await this.bumpVersion();
    return row;
  }

  async updateCategory(
    id: string,
    data: Partial<{
      displayName: Record<string, string>;
      description: Record<string, string>;
      iconUrl: string;
      thumbnailUrl: string;
      capacity: number;
      sortOrder: number;
      isActive: boolean;
      flags: Record<string, boolean>;
      vehicleClass: string;
      etaFactor: number;
    }>,
  ) {
    const [row] = await this.db
      .update(rideCategories)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(rideCategories.id, id))
      .returning();
    if (!row) throw new NotFoundException(`Category ${id} not found`);
    await this.bumpVersion();
    return row;
  }

  async deleteCategory(id: string) {
    await this.db.delete(rideCategories).where(eq(rideCategories.id, id));
    await this.bumpVersion();
  }

  // ── Admin: city availability ─────────────────────────────────────────────
  async setCategoryCityAvailability(
    categoryCode: string,
    city: string,
    isAvailable: boolean,
    sortOrder?: number,
  ) {
    const category = await this.getCategory(categoryCode);
    if (!category)
      throw new NotFoundException(`Category ${categoryCode} not found`);

    const existing = await this.db
      .select()
      .from(rideCategoryCities)
      .where(
        and(
          eq(rideCategoryCities.rideCategoryId, category.id),
          eq(rideCategoryCities.city, city),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const [row] = await this.db
        .update(rideCategoryCities)
        .set({
          isAvailable,
          sortOrder: sortOrder ?? existing[0].sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(rideCategoryCities.id, existing[0].id))
        .returning();
      await this.bumpVersion();
      return row;
    }

    const [row] = await this.db
      .insert(rideCategoryCities)
      .values({
        rideCategoryId: category.id,
        city,
        isAvailable,
        sortOrder: sortOrder ?? 0,
      })
      .returning();
    await this.bumpVersion();
    return row;
  }
}
