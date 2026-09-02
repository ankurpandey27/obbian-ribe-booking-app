import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationWorker } from './workers/notification.worker';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}
