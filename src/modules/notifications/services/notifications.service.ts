import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NOTIFICATIONS } from '../../../common/queues/queues.module';

export type NotificationChannel = 'PUSH' | 'SMS' | 'EMAIL' | 'IN_APP';
export type NotificationType =
  | 'RIDE_ACCEPTED'
  | 'RIDE_ARRIVED'
  | 'RIDE_STARTED'
  | 'RIDE_COMPLETED'
  | 'RIDE_CANCELLED'
  | 'PAYMENT_SUCCESS'
  | 'OTP';

/**
 * NotificationsService — enqueues notifications (BullMQ).
 * FCM push, SMS (MSG91/Twilio), email (SendGrid), in-app via socket.
 * Workers are pluggable; the queue contract is the stable part.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown> = {},
    channels: NotificationChannel[] = ['PUSH', 'IN_APP'],
  ) {
    await this.queue.add(
      'dispatch',
      { userId, type, title, body, data, channels },
      {
        removeOnComplete: { age: 86400 },
        removeOnFail: { age: 86400 * 7 },
      },
    );
    this.logger.debug(`Queued ${type} → ${userId}`);
  }

  /** Ride state-change helpers consumed from ride events. */
  async notifyRideState(
    rideId: string,
    riderId: string,
    driverId: string | undefined,
    state: string,
  ) {
    const title = 'Ride update';
    const body = this.stateMessage(state);
    await this.notify(
      riderId,
      `RIDE_${state}` as NotificationType,
      title,
      body,
      { rideId },
    );

    if (driverId) {
      await this.notify(
        driverId,
        `RIDE_${state}` as NotificationType,
        title,
        body,
        { rideId },
        ['PUSH'],
      );
    }
  }

  private stateMessage(state: string): string {
    const map: Record<string, string> = {
      ACCEPTED: 'Your driver is on the way',
      ARRIVED: 'Your ride is here',
      STARTED: 'Your ride has started',
      COMPLETED: 'Trip completed. Rate your ride!',
      CANCELLED: 'Your ride was cancelled',
    };
    return map[state] ?? 'Ride status updated';
  }
}
