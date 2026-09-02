import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QUEUE_NOTIFICATIONS } from '../../common/queues/queues.module';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  notifications as notificationsTable,
  userDevices,
} from '../../common/database/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { RedisCircuitBreaker } from '../../common/redis/redis-circuit-breaker.service';
import {
  RegisterDeviceDto,
  NotificationPreferencesDto,
} from './dto/notifications.dto';

export type NotificationChannel = 'PUSH' | 'SMS' | 'EMAIL' | 'IN_APP';
export type NotificationType =
  | 'RIDE_ACCEPTED'
  | 'RIDE_ARRIVED'
  | 'RIDE_STARTED'
  | 'RIDE_COMPLETED'
  | 'RIDE_CANCELLED'
  | 'PAYMENT_SUCCESS'
  | 'OTP';

export interface NotificationPreferences {
  push: boolean;
  sms: boolean;
  email: boolean;
  inApp: boolean;
}

/**
 * NotificationsService — enqueues notifications (BullMQ).
 * FCM push, SMS (MSG91/Twilio), email (SendGrid), in-app via socket.
 * Workers are pluggable; the queue contract is the stable part.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    @InjectQueue(QUEUE_NOTIFICATIONS) private readonly queue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly breaker: RedisCircuitBreaker,
  ) {}

  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown> = {},
    channels: NotificationChannel[] = ['PUSH', 'IN_APP'],
  ) {
    const preferences = await this.getPreferences(userId);
    const selected = channels.filter((channel) => {
      const key =
        channel === 'PUSH'
          ? 'push'
          : channel === 'SMS'
            ? 'sms'
            : channel === 'EMAIL'
              ? 'email'
              : 'inApp';
      return preferences[key];
    });
    let notificationId: string | undefined;
    if (selected.includes('IN_APP')) {
      const [notification] = await this.db
        .insert(notificationsTable)
        .values({
          userId,
          notificationType: this.notificationType(type),
          title,
          body,
          data,
          referenceType:
            typeof data['rideId'] === 'string' ? 'ride' : undefined,
          referenceId:
            typeof data['rideId'] === 'string' ? data['rideId'] : undefined,
        })
        .returning({ id: notificationsTable.id });
      notificationId = notification.id;
    }
    const devices = selected.includes('PUSH')
      ? await this.db
          .select({ id: userDevices.id, pushToken: userDevices.pushToken })
          .from(userDevices)
          .where(
            and(
              eq(userDevices.userId, userId),
              eq(userDevices.isPushEnabled, true),
              isNotNull(userDevices.pushToken),
            ),
          )
      : [];
    const pushJobs =
      devices.length > 0
        ? devices.map((device) => ({
            ...data,
            deviceToken: device.pushToken,
            deviceId: device.id,
          }))
        : [data];
    await Promise.all(
      pushJobs.map((jobData) =>
        this.queue.add(
          'dispatch',
          {
            userId,
            type,
            title,
            body,
            data: { ...jobData, notificationId },
            channels: selected,
          },
          {
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 86400 * 7 },
          },
        ),
      ),
    );
  }

  async registerDevice(userId: string, dto: RegisterDeviceDto) {
    const [device] = await this.db
      .insert(userDevices)
      .values({ ...dto, userId, lastActiveAt: new Date() })
      .onConflictDoUpdate({
        target: [userDevices.userId, userDevices.deviceId],
        set: {
          ...dto,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
          isPushEnabled: true,
          pushFailureCount: 0,
        },
      })
      .returning();
    return this.deviceView(device);
  }

  async listDevices(userId: string) {
    const devices = await this.db
      .select()
      .from(userDevices)
      .where(eq(userDevices.userId, userId));
    return devices.map((device) => this.deviceView(device));
  }

  async removeDevice(
    userId: string,
    deviceId: string,
  ): Promise<{ removed: boolean }> {
    const removed = await this.db
      .delete(userDevices)
      .where(
        and(eq(userDevices.userId, userId), eq(userDevices.deviceId, deviceId)),
      )
      .returning({ id: userDevices.id });
    return { removed: removed.length > 0 };
  }

  async list(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, userId))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .offset(Math.max(offset, 0));
  }

  async markRead(userId: string, id: string) {
    const [notification] = await this.db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.id, id),
          eq(notificationsTable.userId, userId),
        ),
      )
      .returning({ id: notificationsTable.id });
    return { read: Boolean(notification) };
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const raw = await this.breaker.execute(
      'notification_preferences',
      'open',
      () => this.redis.get(`notification:prefs:${userId}`),
    );
    const parsed = raw
      ? (JSON.parse(raw) as Partial<NotificationPreferences>)
      : {};
    return {
      push: parsed.push !== false,
      sms: parsed.sms !== false,
      email: parsed.email !== false,
      inApp: parsed.inApp !== false,
    };
  }

  async setPreferences(userId: string, dto: NotificationPreferencesDto) {
    const preferences = { ...(await this.getPreferences(userId)), ...dto };
    await this.breaker.execute('notification_preferences', 'open', () =>
      this.redis.set(
        `notification:prefs:${userId}`,
        JSON.stringify(preferences),
      ),
    );
    return preferences;
  }

  private notificationType(type: NotificationType) {
    if (type === 'PAYMENT_SUCCESS') return 'PAYMENT' as const;
    if (type === 'OTP') return 'SYSTEM' as const;
    return 'RIDE_UPDATE' as const;
  }

  private deviceView(device: typeof userDevices.$inferSelect) {
    return {
      deviceId: device.deviceId,
      platform: device.platform,
      pushEnabled: device.isPushEnabled,
      appVersion: device.appVersion,
      osVersion: device.osVersion,
      deviceModel: device.deviceModel,
      locale: device.locale,
      lastActiveAt: device.lastActiveAt,
    };
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
