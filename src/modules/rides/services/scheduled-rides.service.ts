import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ScheduledRide } from '../entities/scheduled-ride.entity';
import { Ride } from '../entities/ride.entity';
import { PricingService } from '../../pricing/services/pricing.service';
import { QUEUE_SCHEDULED } from '../../../common/queues/queues.module';
import { RideTypeValue } from '../../../shared/types/common';
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

/**
 * ScheduledRidesService — future-dated bookings. Each schedule is a
 * delayed BullMQ job (jobId = schedule id, idempotent). When the job
 * fires, the ride is materialised through the normal request path
 * (createRide → matching dispatch).
 */
@Injectable()
export class ScheduledRidesService {
  private readonly logger = new Logger(ScheduledRidesService.name);
  private readonly maxHoursAhead: number;

  constructor(
    @InjectRepository(ScheduledRide)
    private readonly scheduledRepo: Repository<ScheduledRide>,
    private readonly pricing: PricingService,
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

    const scheduled = await this.scheduledRepo.save({
      riderId: input.riderId,
      pickupLat: input.pickupLat,
      pickupLon: input.pickupLon,
      dropoffLat: input.dropoffLat,
      dropoffLon: input.dropoffLon,
      rideType: input.rideType,
      city: input.city,
      scheduledFor: input.scheduledFor,
      status: 'PENDING',
    });

    // Delayed job fires at scheduledFor; fare is quoted at dispatch time
    // (same price-lock rules as a live request).
    await this.scheduledQueue.add(
      'dispatch',
      {
        scheduledRideId: scheduled.id,
      },
      {
        jobId: `scheduled-${scheduled.id}`,
        delay: at - now,
        removeOnComplete: { age: 86400 },
      },
    );

    this.logger.log(
      `Scheduled ride ${scheduled.id} queued for ${input.scheduledFor.toISOString()}`,
    );
    return scheduled;
  }

  /**
   * BullMQ worker entry: materialise the ride at the scheduled time.
   * Skips if already dispatched/cancelled, or if the rider already has
   * an active ride (the scheduled one wins; it is cancelled instead of
   * stacking).
   */
  async dispatch(scheduledRideId: string): Promise<Ride | null> {
    const scheduled = await this.scheduledRepo.findOneBy({
      id: scheduledRideId,
    });
    if (!scheduled) {
      this.logger.warn(`Scheduled ride ${scheduledRideId} not found`);
      return null;
    }
    if (scheduled.status !== 'PENDING') return null;

    const active = await this.ridesService.getActiveRidesForRider(
      scheduled.riderId,
    );
    if (active.length > 0) {
      await this.scheduledRepo.update(scheduled.id, { status: 'CANCELLED' });
      this.logger.warn(
        `Scheduled ride ${scheduled.id} cancelled: rider already active`,
      );
      return null;
    }

    const quote = await this.pricing.getQuote(
      scheduled.pickupLat,
      scheduled.pickupLon,
      scheduled.dropoffLat,
      scheduled.dropoffLon,
      scheduled.city,
      [scheduled.rideType],
    );
    const config = await this.pricing.getConfig(
      scheduled.city,
      scheduled.rideType,
    );

    // Same path as a live request — price lock at scheduled quote.
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

    await this.scheduledRepo.update(scheduled.id, {
      status: 'DISPATCHED',
      rideId: ride.id,
    });
    return ride;
  }

  async listForRider(riderId: string): Promise<ScheduledRide[]> {
    return this.scheduledRepo.find({
      where: { riderId },
      order: { scheduledFor: 'ASC' },
      take: 20,
    });
  }

  async cancel(riderId: string, id: string): Promise<{ cancelled: boolean }> {
    const scheduled = await this.scheduledRepo.findOneBy({ id });
    if (!scheduled || scheduled.riderId !== riderId) {
      throw new NotFoundException('Scheduled ride not found');
    }
    if (scheduled.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot cancel: status is ${scheduled.status}`,
      );
    }
    await this.scheduledRepo.update(id, { status: 'CANCELLED' });
    await this.scheduledQueue.remove(`scheduled-${id}`).catch(() => undefined);
    return { cancelled: true };
  }
}
