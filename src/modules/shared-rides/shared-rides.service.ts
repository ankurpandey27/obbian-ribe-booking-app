import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  groupMembers,
  groups,
  ridePoolMembers,
  ridePools,
} from '../../common/database/schema';
import { v4 as uuidv4 } from 'uuid';

export interface CreatePoolInput {
  categoryCode: string;
  city: string;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  maxSeats?: number;
  groupId?: string;
  windowStart?: Date;
  windowEnd?: Date;
}

export interface JoinPoolInput {
  poolId: string;
  riderId: string;
  seats?: number;
}

@Injectable()
export class SharedRideService {
  private readonly logger = new Logger(SharedRideService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  /** Create a new ride pool (She-Share / Corporate Pooling). */
  async createPool(input: CreatePoolInput) {
    const [pool] = await this.db
      .insert(ridePools)
      .values({
        id: uuidv4(),
        categoryCode: input.categoryCode,
        city: input.city,
        originLat: input.originLat,
        originLon: input.originLon,
        destLat: input.destLat,
        destLon: input.destLon,
        maxSeats: input.maxSeats ?? 4,
        groupId: input.groupId ?? null,
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
      })
      .returning();
    return pool;
  }

  /** Find an existing FORMING pool that matches the corridor + time window. */
  async findMatchingPool(input: {
    categoryCode: string;
    city: string;
    originLat: number;
    originLon: number;
    destLat: number;
    destLon: number;
    groupId?: string;
  }) {
    // Simple matching: same category + city + group, with origin/dest within ~2km
    // Uses a coarse bounding-box filter; production would use proper geo matching.
    const KM = 0.009; // ~1 degree ≈ 111km, so 2km ≈ 0.018 degrees
    const rows = await this.db
      .select()
      .from(ridePools)
      .where(
        and(
          eq(ridePools.status, 'FORMING'),
          eq(ridePools.categoryCode, input.categoryCode),
          eq(ridePools.city, input.city),
          sql`ABS(${ridePools.originLat} - ${input.originLat}) < ${2 * KM}`,
          sql`ABS(${ridePools.originLon} - ${input.originLon}) < ${2 * KM}`,
          sql`ABS(${ridePools.destLat} - ${input.destLat}) < ${2 * KM}`,
          sql`ABS(${ridePools.destLon} - ${input.destLon}) < ${2 * KM}`,
          input.groupId
            ? eq(ridePools.groupId, input.groupId)
            : sql`${ridePools.groupId} IS NULL`,
        ),
      )
      .orderBy(desc(ridePools.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Join an existing pool or create a new one if none matches. */
  async joinOrCreatePool(
    input: CreatePoolInput & { riderId: string; seats?: number },
  ) {
    const existing = await this.findMatchingPool(input);
    if (existing) {
      return this.joinPool({
        poolId: existing.id,
        riderId: input.riderId,
        seats: input.seats,
      });
    }
    const pool = await this.createPool(input);
    return this.joinPool({
      poolId: pool.id,
      riderId: input.riderId,
      seats: input.seats,
    });
  }

  /**
   * Add a rider to a pool. Enforces seat capacity with an ATOMIC conditional
   * update to prevent TOCTOU overbooking (AGENTS.md §4). The UNIQUE
   * (poolId, riderId) index also prevents duplicate joins.
   */
  async joinPool(input: JoinPoolInput) {
    const seats = input.seats ?? 1;

    // ATOMIC CLAIM: increment bookedSeats only if capacity allows. The WHERE
    // clause makes the check-and-update atomic — concurrent joins cannot both
    // pass the capacity check.
    const [updated] = await this.db
      .update(ridePools)
      .set({
        bookedSeats: sql`${ridePools.bookedSeats} + ${seats}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ridePools.id, input.poolId),
          eq(ridePools.status, 'FORMING'),
          sql`${ridePools.bookedSeats} + ${seats} <= ${ridePools.maxSeats}`,
        ),
      )
      .returning();

    if (!updated) {
      // Distinguish "not found / not forming" from "full" for a clearer error.
      const pool = await this.getPool(input.poolId);
      if (!pool || pool.status !== 'FORMING') {
        throw new NotFoundException(
          `Pool ${input.poolId} not found or no longer forming`,
        );
      }
      throw new BadRequestException(
        `Pool ${input.poolId} has no seats available`,
      );
    }

    // Insert member. UNIQUE (poolId, riderId) prevents duplicate joins. The
    // atomic seat claim + member insert are kept close together; the UNIQUE
    // index is the final guard against overbooking races.
    const [member] = await this.db
      .insert(ridePoolMembers)
      .values({
        id: uuidv4(),
        poolId: input.poolId,
        riderId: input.riderId,
        seats,
        joinStatus: 'CONFIRMED',
      })
      .returning();

    if (!member) {
      // Lost the race — release the claimed seat so it's not orphaned.
      await this.db
        .update(ridePools)
        .set({ bookedSeats: sql`${ridePools.bookedSeats} - ${seats}` })
        .where(eq(ridePools.id, input.poolId));
      throw new ConflictException(`Failed to join pool ${input.poolId}; retry`);
    }

    return member;
  }

  async getPool(poolId: string) {
    const [pool] = await this.db
      .select()
      .from(ridePools)
      .where(eq(ridePools.id, poolId))
      .limit(1);
    return pool ?? null;
  }

  async getPoolMembers(poolId: string) {
    return this.db
      .select()
      .from(ridePoolMembers)
      .where(eq(ridePoolMembers.poolId, poolId));
  }

  /** Lock a pool (no more members) and prepare for dispatch. */
  async lockPool(poolId: string) {
    const [pool] = await this.db
      .update(ridePools)
      .set({ status: 'LOCKED', updatedAt: new Date() })
      .where(and(eq(ridePools.id, poolId), eq(ridePools.status, 'FORMING')))
      .returning();
    if (!pool) throw new NotFoundException(`Pool ${poolId} cannot be locked`);
    return pool;
  }

  /** Split fare across pool members. */
  async calculateShareFare(poolId: string, totalFarePaise: number) {
    const members = await this.getPoolMembers(poolId);
    const totalSeats = members.reduce((sum, m) => sum + m.seats, 0);
    if (totalSeats === 0) return;

    // Split proportionally by seats
    for (const member of members) {
      const share = Math.round((totalFarePaise * member.seats) / totalSeats);
      await this.db
        .update(ridePoolMembers)
        .set({ shareFarePaise: share, updatedAt: new Date() })
        .where(eq(ridePoolMembers.id, member.id));
    }

    await this.db
      .update(ridePools)
      .set({ totalFarePaise, updatedAt: new Date() })
      .where(eq(ridePools.id, poolId));
  }

  // ── Groups ──────────────────────────────────────────────────────────────
  async createGroup(input: {
    type: 'PUBLIC' | 'PRIVATE' | 'COMMUNITY' | 'CORPORATE';
    ownerId: string;
    name: string;
    city?: string;
  }) {
    const [group] = await this.db
      .insert(groups)
      .values({
        id: uuidv4(),
        type: input.type,
        ownerId: input.ownerId,
        name: input.name,
        city: input.city ?? null,
      })
      .returning();

    // Owner is automatically an ADMIN
    await this.db.insert(groupMembers).values({
      id: uuidv4(),
      groupId: group.id,
      userId: input.ownerId,
      role: 'ADMIN',
    });

    return group;
  }

  async addGroupMember(groupId: string, userId: string, role = 'MEMBER') {
    const [member] = await this.db
      .insert(groupMembers)
      .values({
        id: uuidv4(),
        groupId,
        userId,
        role: role as 'ADMIN' | 'MEMBER',
      })
      .returning();
    return member;
  }

  async getGroup(groupId: string) {
    const [group] = await this.db
      .select()
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    return group ?? null;
  }

  async getGroupMembers(groupId: string) {
    return this.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
  }
}
