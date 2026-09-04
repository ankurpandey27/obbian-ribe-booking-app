import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { asc, eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { scheduledRides } from '../../common/database/schema';
import { QUEUE_SCHEDULED } from '../../common/queues/queues.module';
import { RideTypeValue } from '../../shared/types/common';
import { PricingService } from '../pricing/pricing.service';
import { FraudService } from './fraud.service';
import { Ride } from './entities/ride.entity';
import { ScheduledRide } from './entities/scheduled-ride.entity';
import { RidesService } from './rides.service';

export interface ScheduleRideInput {
  riderId: string;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
  rideType: RideTypeValue;
  city: string;
  scheduledFor: Date;
}

@Injectable()
export class ScheduledRidesService {
  private readonly logger = new Logger(ScheduledRidesService.name);
  private readonly maxHoursAhead: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly pricing: PricingService,
    private readonly fraud: FraudService,
    private readonly ridesService: RidesService,
    @InjectQueue(QUEUE_SCHEDULED) private readonly scheduledQueue: Queue,
    config: ConfigService,
  ) {
    this.maxHoursAhead = config.get<number>('scheduledRides.maxHoursAhead', 24);
  }

  async schedule(input: ScheduleRideInput): Promise<ScheduledRide> {
    const now = Date.now();
    const at = input.scheduledFor.getTime();
    if (at <= now + 5 * 60 * 1000) {
      throw new BadRequestException(
        'scheduledFor must be at least 5 minutes in the future',
      );
    }
    if (at > now + this.maxHoursAhead * 60 * 60 * 1000) {
      throw new BadRequestException(
        `scheduledFor cannot be more than ${this.maxHoursAhead}h ahead`,
      );
    }

    const [scheduled] = await this.db
      .insert(scheduledRides)
      .values({ ...input, status: 'PENDING' })
      .returning();

    await this.scheduledQueue.add(
      'dispatch',
      { scheduledRideId: scheduled.id },
      {
        jobId: `scheduled-${scheduled.id}`,
        delay: at - now,
        removeOnComplete: { age: 86400 },
      },
    );
    return scheduled;
  }

  async dispatch(scheduledRideId: string): Promise<Ride | null> {
    const [scheduled] = await this.db
      .select()
      .from(scheduledRides)
      .where(eq(scheduledRides.id, scheduledRideId))
      .limit(1);
    if (!scheduled || scheduled.status !== 'PENDING') return null;

    const active = await this.ridesService.getActiveRidesForRider(
      scheduled.riderId,
    );
    if (active.length > 0) {
      await this.db
        .update(scheduledRides)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(scheduledRides.id, scheduled.id));
      this.logger.warn('scheduled ride cancelled because rider is active');
      return null;
    }

    const [quote, config] = await Promise.all([
      this.pricing.getQuote(
        scheduled.pickupLat,
        scheduled.pickupLon,
        scheduled.dropoffLat,
        scheduled.dropoffLon,
        scheduled.city,
        [scheduled.rideType],
      ),
      this.pricing.getConfig(scheduled.city, scheduled.rideType),
      this.fraud.guardRideRequest(
        scheduled.riderId,
        scheduled.pickupLat,
        scheduled.pickupLon,
        scheduled.city,
      ),
    ]);
    const ride = await this.ridesService.createRide({
      riderId: scheduled.riderId,
      pickupLat: scheduled.pickupLat,
      pickupLon: scheduled.pickupLon,
      dropoffLat: scheduled.dropoffLat,
      dropoffLon: scheduled.dropoffLon,
      rideType: scheduled.rideType,
      city: scheduled.city,
      estimatedFare: this.pricing.calculateFare(
        config,
        quote.distanceKm,
        quote.durationMin,
      ),
      distanceKm: quote.distanceKm,
      durationMin: Math.max(0, Math.round(quote.durationMin ?? 0)),
      surgeMultiplier: quote.surgeMultiplier ?? Number(config.surgeMultiplier),
    });
    await this.db
      .update(scheduledRides)
      .set({ status: 'DISPATCHED', rideId: ride.id, updatedAt: new Date() })
      .where(eq(scheduledRides.id, scheduled.id));
    return ride;
  }

  async listForRider(riderId: string): Promise<ScheduledRide[]> {
    const rows = await this.db
      .select()
      .from(scheduledRides)
      .where(eq(scheduledRides.riderId, riderId))
      .orderBy(asc(scheduledRides.scheduledFor))
      .limit(20);
    return rows;
  }

  async cancel(riderId: string, id: string): Promise<{ cancelled: boolean }> {
    const [scheduled] = await this.db
      .select()
      .from(scheduledRides)
      .where(eq(scheduledRides.id, id))
      .limit(1);
    if (!scheduled || scheduled.riderId !== riderId) {
      throw new NotFoundException('Scheduled ride not found');
    }
    if (scheduled.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot cancel: status is ${scheduled.status}`,
      );
    }
    await this.db
      .update(scheduledRides)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(scheduledRides.id, id));
    await this.scheduledQueue.remove(`scheduled-${id}`).catch(() => undefined);
    return { cancelled: true };
  }
}
