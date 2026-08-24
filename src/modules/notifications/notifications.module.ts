import { Module } from '@nestjs/common';
import { NotificationsService } from './services/notifications.service';
import { NotificationWorker } from './services/notification.worker';

@Module({
  imports: [],
  providers: [NotificationsService, NotificationWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}
