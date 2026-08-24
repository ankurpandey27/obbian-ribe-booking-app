import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DB,
  DrizzleDB,
} from '../../../common/database/drizzle.module';
import { users } from '../../../common/database/schema';
import { QUEUE_NOTIFICATIONS } from '../../../common/queues/queues.module';
import { NotificationChannel, NotificationType } from './notifications.service';
import { User } from '../../users/entities/user.entity';
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
        send: () => {
          this.logger.debug('[sms-skip] SMS provider not configured');
          return Promise.resolve();
        },
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
    // IN_APP is delivered via the tracking gateway (socket rooms)
    this.logger.debug(`[in-app] ${type} → ${userId}`, data);
  }

  private async dispatchPush(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.push.enabled) {
      this.logger.debug(`[push-skip] ${type} → ${userId}`);
      return;
    }
    const deviceToken = data?.deviceToken as string | undefined;
    if (!deviceToken) {
      this.logger.warn(
        `[push-skip] ${type} → ${userId}: no deviceToken in job data`,
      );
      return;
    }
    try {
      await this.push.send(deviceToken, title, body, data);
    } catch (err) {
      this.logger.error(`[push-fail] ${type} → ${userId}: ${err.message}`);
    }
  }

  private async dispatchSms(userId: string, body: string): Promise<void> {
    try {
      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.phoneNumber) {
        this.logger.warn(`[sms-skip] → ${userId}: no phone on file`);
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
      this.logger.debug(`[email-skip] ${title} → ${userId}`);
      return;
    }
    try {
      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.email) {
        this.logger.warn(`[email-skip] → ${userId}: no email on file`);
        return;
      }
      await this.email.send(user.email, title, body);
    } catch (err) {
      this.logger.error(`[email-fail] → ${userId}: ${err.message}`);
    }
  }
}
