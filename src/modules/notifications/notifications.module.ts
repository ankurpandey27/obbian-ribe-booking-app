import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsService } from './services/notifications.service';
import { NotificationWorker } from './services/notification.worker';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [NotificationsService, NotificationWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}
