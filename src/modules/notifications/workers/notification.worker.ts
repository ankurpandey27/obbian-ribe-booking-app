import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../../common/database/drizzle.module';
import {
  notifications,
  userDevices,
  users,
} from '../../../common/database/schema';
import { QUEUE_NOTIFICATIONS } from '../../../common/queues/queues.module';
import {
  NotificationChannel,
  NotificationType,
} from '../notifications.service';
import { FcmPushProvider } from '../providers/push.provider';
import { SendGridEmailProvider } from '../providers/email.provider';
import {
  createSmsProvider,
  SmsProvider,
} from '../../../common/sms/sms-providers';

const SMS_BODY_MAX = 140;

/**
 * Notification worker — dispatches via FCM push / SMS (MSG91/Twilio) /
 * SendGrid email. Each channel fails soft: a provider error is logged
 * and the job completes so a bad credential never blocks the queue.
 * Push device tokens arrive via `data.deviceToken` (sent by the apps;
 * persist per user with a migration for multi-device support).
 */
@Processor(QUEUE_NOTIFICATIONS)
export class NotificationWorker extends WorkerHost {
  private readonly logger = new Logger(NotificationWorker.name);
  private readonly push: FcmPushProvider;
  private readonly email: SendGridEmailProvider;
  private readonly sms: SmsProvider;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    super();
    this.push = new FcmPushProvider(config);
    this.email = new SendGridEmailProvider(config);
    try {
      this.sms = createSmsProvider(config);
    } catch (err) {
      this.logger.warn((err as Error).message);
      this.sms = {
        send: () => Promise.resolve(),
      };
    }
  }

  async process(
    job: Job<{
      userId: string;
      type: NotificationType;
      title: string;
      body: string;
      data: Record<string, unknown>;
      channels: NotificationChannel[];
    }>,
  ) {
    const { userId, type, title, body, data, channels } = job.data;

    if (channels.includes('PUSH')) {
      await this.dispatchPush(userId, type, title, body, data);
    }
    if (channels.includes('SMS')) {
      await this.dispatchSms(userId, body);
    }
    if (channels.includes('EMAIL')) {
      await this.dispatchEmail(userId, title, body);
    }
  }

  private async dispatchPush(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.push.enabled) {
      return;
    }
    const deviceToken = data?.deviceToken as string | undefined;
    if (!deviceToken) {
      return;
    }
    try {
      await this.push.send(deviceToken, title, body, data);
      const deviceId = data.deviceId as string | undefined;
      const notificationId = data.notificationId as string | undefined;
      if (deviceId) {
        await this.db
          .update(userDevices)
          .set({
            pushFailureCount: 0,
            lastActiveAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(userDevices.id, deviceId));
      }
      if (notificationId) {
        await this.db
          .update(notifications)
          .set({ pushedAt: new Date() })
          .where(eq(notifications.id, notificationId));
      }
    } catch (err) {
      this.logger.error(`[push-fail] ${type} → ${userId}: ${err.message}`);
      const deviceId = data.deviceId as string | undefined;
      if (deviceId) {
        await this.db
          .update(userDevices)
          .set({
            pushFailureCount: sql`${userDevices.pushFailureCount} + 1`,
            isPushEnabled: sql`case when ${userDevices.pushFailureCount} + 1 >= 3 then false else ${userDevices.isPushEnabled} end`,
            updatedAt: new Date(),
          })
          .where(eq(userDevices.id, deviceId))
          .catch(() => undefined);
      }
    }
  }

  private async dispatchSms(userId: string, body: string): Promise<void> {
    try {
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user?.phoneNumber) {
        return;
      }
      const message =
        body.length > SMS_BODY_MAX
          ? `${body.slice(0, SMS_BODY_MAX - 1)}…`
          : body;
      await this.sms.send(user.phoneNumber, message);
    } catch (err) {
      this.logger.error(`[sms-fail] → ${userId}: ${err.message}`);
    }
  }

  private async dispatchEmail(
    userId: string,
    title: string,
    body: string,
  ): Promise<void> {
    if (!this.email.enabled) {
      return;
    }
    try {
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user?.email) {
        return;
      }
      await this.email.send(user.email, title, body);
    } catch (err) {
      this.logger.error(`[email-fail] → ${userId}: ${err.message}`);
    }
  }
}
