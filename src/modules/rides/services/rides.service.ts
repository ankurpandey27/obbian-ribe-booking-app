import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Ride } from '../entities/ride.entity';
import { RideStateMachine } from '../state-machine/ride-state-machine';
import { OutboxService } from '../../../common/events/outbox.service';
import { TOPICS } from '../../../shared/events/topics';
import { RideEventType } from '../../../shared/events/contracts';
import { QUEUE_MATCHING } from '../../../common/queues/queues.module';
import { PricingService } from '../../pricing/services/pricing.service';
import { DriversService } from '../../drivers/services/drivers.service';
import {
  CancellationReasonValue,
  RideStatusValue,
  RideTypeValue,
} from '../../../shared/types/common';

export interface RequestRideInput {
  riderId: string;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
  rideType: RideTypeValue;
  city: string;
  estimatedFare: number;
  distanceKm: number;
  durationMin: number;
  surgeMultiplier: number;
  promoCode?: string;
  promoDiscount?: number;
}

/**
 * RidesService — ride lifecycle owner. Every transition goes through
 * the state machine and is committed together with its outbox event
 * (atomic durability — no state change can exist without its event).
 */
@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @InjectRepository(Ride) private readonly rideRepo: Repository<Ride>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly pricing: PricingService,
    private readonly drivers: DriversService,
    @InjectQueue(QUEUE_MATCHING) private readonly matchingQueue: Queue,
  ) {}

  async createRide(input: RequestRideInput): Promise<Ride> {
    const ride = await this.dataSource.transaction(async (em) => {
      const saved = await em.save(Ride, { ...input, status: 'REQUESTED' });
      await this.outbox.write(em, {
        topic: TOPICS.RIDE_EVENTS,
        type: RideEventType.RIDE_REQUESTED,
        aggregateType: 'ride',
        aggregateId: saved.id,
        payload: {
          rideId: saved.id,
          riderId: saved.riderId,
          status: saved.status,
          rideType: saved.rideType,
          occurredAt: new Date().toISOString(),
        },
      });
      return saved;
    });

    // Kick off driver dispatch off the HTTP path. jobId = idempotent per ride.
    await this.matchingQueue
      .add('match', { rideId: ride.id }, { jobId: `match-${ride.id}` })
      .catch((err) =>
        this.logger.error(
          `matching enqueue failed for ${ride.id}`,
          err.message,
        ),
      );
    return ride;
  }

  async getRide(rideId: string): Promise<Ride> {
    const ride = await this.rideRepo.findOneBy({ id: rideId });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);
    return ride;
  }

  async getActiveRidesForRider(riderId: string): Promise<Ride[]> {
    return this.rideRepo.find({
      where: {
        riderId,
        status: In([
          'REQUESTED',
          'MATCHING',
          'ACCEPTED',
          'ARRIVED',
          'IN_PROGRESS',
        ]),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async getActiveRideForDriver(driverId: string): Promise<Ride | null> {
    return this.rideRepo.findOneBy({
      driverId,
      status: In(['ACCEPTED', 'ARRIVED', 'IN_PROGRESS']),
    });
  }

  async getHistoryForRider(
    riderId: string,
    limit = 20,
    offset = 0,
  ): Promise<Ride[]> {
    return this.rideRepo.find({
      where: { riderId, status: 'COMPLETED' },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async transition(
    rideId: string,
    to: RideStatusValue,
    patch: Partial<Ride> = {},
    eventType = `RIDE_${to}`,
  ): Promise<Ride> {
    const ride = await this.getRide(rideId);
    RideStateMachine.assertTransition(ride.status, to);

    // One transaction: conditional state update + durable outbox event.
    // The update is keyed on the observed status — two concurrent
    // transitions race on the DB row, exactly one wins, the loser gets a
    // Conflict instead of silently double-applying.
    const updated = await this.dataSource.transaction(async (em) => {
      const result = await em.update(
        Ride,
        { id: rideId, status: ride.status },
        { ...patch, status: to },
      );
      if (!result.affected) {
        throw new ConflictException(
          `Ride ${rideId} changed concurrently (was ${ride.status})`,
        );
      }

      const merged: Ride = { ...ride, ...patch, status: to };
      await this.outbox.write(em, {
        topic: TOPICS.RIDE_EVENTS,
        type: eventType,
        aggregateType: 'ride',
        aggregateId: merged.id,
        payload: {
          rideId: merged.id,
          riderId: merged.riderId,
          driverId: merged.driverId,
          status: merged.status,
          rideType: merged.rideType,
          totalFare: merged.totalFare ? Number(merged.totalFare) : undefined,
          cancellationReason: merged.cancellationReason,
          cancellationFee: Number(merged.cancellationFee),
          occurredAt: new Date().toISOString(),
        },
      });
      return merged;
    });

    return updated;
  }

  /** Driver arrived at pickup point. */
  async driverArrive(rideId: string): Promise<Ride> {
    return this.transition(rideId, 'ARRIVED', { arrivedAt: new Date() });
  }

  /** Driver started the trip. */
  async driverStart(rideId: string): Promise<Ride> {
    return this.transition(rideId, 'IN_PROGRESS', { startedAt: new Date() });
  }

  /** Driver completed the trip — final fare from road config, not estimate. */
  async completeRide(rideId: string): Promise<Ride> {
    const ride = await this.getRide(rideId);
    const config = await this.pricing.getConfig(ride.city, ride.rideType);
    const fare = this.pricing.calculateFare(
      config,
      Number(ride.distanceKm),
      ride.durationMin,
    );
    // Promo discount applied at completion against the final fare.
    const discount = Number(ride.promoDiscount) || 0;
    const totalFare = Math.max(0, fare - discount);
    const completed = await this.transition(rideId, 'COMPLETED', {
      totalFare,
      completedAt: new Date(),
    });

    // Driver back ONLINE + matchable at pickup. Self-healing side effect —
    // must not add latency to the driver's completion response.
    if (ride.driverId) {
      void this.drivers
        .completeRide(ride.driverId, ride.pickupLat, ride.pickupLon)
        .catch((err) =>
          this.logger.error(
            `driver restore failed for ${ride.driverId}`,
            err.message,
          ),
        );
    }
    return completed;
  }

  /** Rider or driver cancellation with fee rules. */
  async cancel(
    rideId: string,
    reason: CancellationReasonValue,
    cancelledBy: 'RIDER' | 'DRIVER' | 'SYSTEM',
  ): Promise<{ ride: Ride; refundAmount: number }> {
    const ride = await this.getRide(rideId);
    if (!RideStateMachine.canCancel(ride.status)) {
      throw new BadRequestException(
        `Ride in state ${ride.status} cannot be cancelled`,
      );
    }

    let fee = 0;
    if (cancelledBy === 'RIDER') {
      const minutesSinceRequest =
        (Date.now() - ride.createdAt.getTime()) / 60000;
      fee = minutesSinceRequest > 2 ? 50 : 0; // free within 2 min, ₹50 after
    } else if (cancelledBy === 'DRIVER') {
      fee = 50; // driver-initiated cancellation fine
    }

    const cancelled = await this.transition(
      rideId,
      'CANCELLED',
      {
        cancellationReason: reason,
        cancellationFee: fee,
        cancelledAt: new Date(),
      },
      'RIDE_CANCELLED',
    );

    return {
      ride: cancelled,
      refundAmount: Number(cancelled.estimatedFare) - fee,
    };
  }
}
