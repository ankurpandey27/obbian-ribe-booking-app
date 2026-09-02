import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { rideStops, rides } from '../../common/database/schema';

export interface RideStopInput {
  lat: number;
  lon: number;
  address?: string;
}

export interface RideStopSummary {
  extraStops: number;
  waitingMinutes: number;
}

const STOP_MUTABLE_STATUSES = ['REQUESTED', 'MATCHING', 'ACCEPTED', 'ARRIVED'];

@Injectable()
export class RideStopsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async addStops(rideId: string, stops: RideStopInput[], riderId?: string) {
    if (stops.length === 0) return [];

    const [ride] = await this.db
      .select({ status: rides.status })
      .from(rides)
      .where(eq(rides.id, rideId))
      .limit(1);
    if (!ride) throw new NotFoundException('Ride not found');
    if (riderId && ride.status && (await this.rideOwner(rideId)) !== riderId) {
      throw new BadRequestException('Only the rider can change stops');
    }
    if (!STOP_MUTABLE_STATUSES.includes(ride.status)) {
      throw new BadRequestException(
        'Stops cannot be changed after the ride starts',
      );
    }

    const existing = await this.db
      .select({ stopOrder: rideStops.stopOrder })
      .from(rideStops)
      .where(eq(rideStops.rideId, rideId));
    const firstOrder =
      Math.max(0, ...existing.map((stop) => stop.stopOrder)) + 1;
    const inserted = await this.db
      .insert(rideStops)
      .values(
        stops.map((stop, index) => ({
          rideId,
          stopOrder: firstOrder + index,
          lat: stop.lat,
          lon: stop.lon,
          address: stop.address,
        })),
      )
      .returning();
    await this.db
      .update(rides)
      .set({ stopCount: firstOrder + stops.length - 1, updatedAt: new Date() })
      .where(eq(rides.id, rideId));
    return inserted;
  }

  async list(rideId: string) {
    return this.db
      .select()
      .from(rideStops)
      .where(eq(rideStops.rideId, rideId))
      .orderBy(asc(rideStops.stopOrder));
  }

  async markArrived(rideId: string, stopId: string, driverId?: string) {
    await this.assertAssignedDriver(rideId, driverId);
    const [updated] = await this.db
      .update(rideStops)
      .set({ status: 'ARRIVED', arrivedAt: new Date() })
      .where(
        and(
          eq(rideStops.id, stopId),
          eq(rideStops.rideId, rideId),
          eq(rideStops.status, 'PENDING'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('Stop is not pending');
    return updated;
  }

  async markDeparted(rideId: string, stopId: string, driverId?: string) {
    await this.assertAssignedDriver(rideId, driverId);
    const [updated] = await this.db
      .update(rideStops)
      .set({ status: 'COMPLETED', departedAt: new Date() })
      .where(
        and(
          eq(rideStops.id, stopId),
          eq(rideStops.rideId, rideId),
          eq(rideStops.status, 'ARRIVED'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('Stop is not arrived');
    return updated;
  }

  async skip(rideId: string, stopId: string, driverId?: string) {
    await this.assertAssignedDriver(rideId, driverId);
    const [updated] = await this.db
      .update(rideStops)
      .set({ status: 'SKIPPED' })
      .where(
        and(
          eq(rideStops.id, stopId),
          eq(rideStops.rideId, rideId),
          ne(rideStops.status, 'COMPLETED'),
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException('Stop cannot be skipped');
    return updated;
  }

  async summarise(rideId: string): Promise<RideStopSummary> {
    const [summary] = await this.db
      .select({
        extraStops: sql<number>`count(*) filter (where ${rideStops.status} <> 'SKIPPED')`,
        waitingMinutes: sql<number>`coalesce(sum(case when ${rideStops.arrivedAt} is not null then greatest(0, extract(epoch from (coalesce(${rideStops.departedAt}, now()) - ${rideStops.arrivedAt})) / 60) else 0 end), 0)`,
      })
      .from(rideStops)
      .where(eq(rideStops.rideId, rideId));
    return {
      extraStops: Number(summary?.extraStops ?? 0),
      waitingMinutes: Number(summary?.waitingMinutes ?? 0),
    };
  }

  private async rideOwner(rideId: string): Promise<string | null> {
    const [ride] = await this.db
      .select({ riderId: rides.riderId })
      .from(rides)
      .where(eq(rides.id, rideId))
      .limit(1);
    return ride?.riderId ?? null;
  }

  private async assertAssignedDriver(
    rideId: string,
    driverId?: string,
  ): Promise<void> {
    if (!driverId) return;
    const [ride] = await this.db
      .select({ driverId: rides.driverId })
      .from(rides)
      .where(eq(rides.id, rideId))
      .limit(1);
    if (!ride || ride.driverId !== driverId) {
      throw new BadRequestException(
        'Only the assigned driver can update stops',
      );
    }
  }
}
