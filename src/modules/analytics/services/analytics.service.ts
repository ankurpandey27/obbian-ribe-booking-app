import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Ride } from '../../rides/entities/ride.entity';

export interface AnalyticsSummary {
  from: string;
  to: string;
  totals: {
    ridesRequested: number;
    ridesCompleted: number;
    ridesCancelled: number;
    cancellationRate: number;
    gmv: number;
    avgFare: number;
    avgRiderRating: number;
    avgDriverRating: number;
  };
  ridesByStatus: Record<string, number>;
  ridesPerDay: { date: string; count: number; gmv: number }[];
  topRoutes: { route: string; count: number }[];
  drivers: { onlineNow: number; totalDrivers: number };
}

/**
 * AnalyticsService — read-only aggregates over the rides table.
 * Cheap enough for dashboard polling; heavy rollups can be added later
 * as Kafka consumers writing to a materialised table.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
  ) {}

  async summary(days = 30): Promise<AnalyticsSummary> {
    const to = new Date();
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rides = await this.rideRepo.find({
      where: { createdAt: MoreThanOrEqual(from) },
      select: [
        'id',
        'status',
        'totalFare',
        'estimatedFare',
        'riderRating',
        'driverRating',
        'createdAt',
        'pickupLat',
        'pickupLon',
        'dropoffLat',
        'dropoffLon',
      ],
    });

    if (rides.length === 0) {
      throw new NotFoundException('No ride data in the selected window');
    }

    const completed = rides.filter((r) => r.status === 'COMPLETED');
    const cancelled = rides.filter((r) => r.status === 'CANCELLED');
    const gmv = completed.reduce(
      (sum, r) => sum + Number(r.totalFare ?? r.estimatedFare ?? 0),
      0,
    );
    const ratedByRider = completed.filter((r) => r.riderRating != null);
    const ratedByDriver = completed.filter((r) => r.driverRating != null);

    // Rides per calendar day (UTC) — gmv for completed only.
    const perDay = new Map<string, { count: number; gmv: number }>();
    for (const r of rides) {
      const key = r.createdAt.toISOString().slice(0, 10);
      const entry = perDay.get(key) ?? { count: 0, gmv: 0 };
      entry.count += 1;
      if (r.status === 'COMPLETED') {
        entry.gmv += Number(r.totalFare ?? r.estimatedFare ?? 0);
      }
      perDay.set(key, entry);
    }

    // Top routes by completed trips.
    const routeCounts = new Map<string, number>();
    for (const r of completed) {
      const key = `${r.pickupLat.toFixed(3)},${r.pickupLon.toFixed(3)} → ${r.dropoffLat.toFixed(3)},${r.dropoffLon.toFixed(3)}`;
      routeCounts.set(key, (routeCounts.get(key) ?? 0) + 1);
    }

    const statuses = [
      'REQUESTED',
      'MATCHING',
      'ACCEPTED',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];
    const ridesByStatus: Record<string, number> = Object.fromEntries(
      statuses.map((s) => [s, rides.filter((r) => r.status === s).length]),
    );

    const { totalDrivers } = await this.rideRepo.manager
      .query(`SELECT (SELECT count(*) FROM drivers)::int AS "totalDrivers"`)
      .then(
        (rows: { totalDrivers: number }[]) => rows[0] ?? { totalDrivers: 0 },
      );
    const onlineNow = await this.rideRepo.manager
      .query(`SELECT count(*)::int AS n FROM drivers WHERE status = 'ONLINE'`)
      .then((rows: { n: number }[]) => rows[0]?.n ?? 0);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        ridesRequested: rides.length,
        ridesCompleted: completed.length,
        ridesCancelled: cancelled.length,
        cancellationRate: rides.length
          ? Math.round((cancelled.length / rides.length) * 1000) / 10
          : 0,
        gmv: Math.round(gmv * 100) / 100,
        avgFare: completed.length
          ? Math.round((gmv / completed.length) * 100) / 100
          : 0,
        avgRiderRating:
          ratedByRider.length > 0
            ? Math.round(
                (ratedByRider.reduce((s, r) => s + Number(r.riderRating), 0) /
                  ratedByRider.length) *
                  100,
              ) / 100
            : 0,
        avgDriverRating:
          ratedByDriver.length > 0
            ? Math.round(
                (ratedByDriver.reduce((s, r) => s + Number(r.driverRating), 0) /
                  ratedByDriver.length) *
                  100,
              ) / 100
            : 0,
      },
      ridesByStatus,
      ridesPerDay: [...perDay.entries()]
        .map(([date, v]) => ({
          date,
          count: v.count,
          gmv: Math.round(v.gmv * 100) / 100,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topRoutes: [...routeCounts.entries()]
        .map(([route, count]) => ({ route, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      drivers: { onlineNow, totalDrivers },
    };
  }
}
