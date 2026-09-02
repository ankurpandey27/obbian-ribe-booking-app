import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { UsersModule } from '../users/users.module';

/**
 * Drivers �?" profile, availability, live position. Future `user-svc` slice.
 *
 * GeoService is NOT declared here: it is provided globally by RedisModule.
 * It used to be duplicated across drivers/matching/tracking (three instances of
 * one stateless wrapper) while pricing lacked it entirely.
 */
@Module({
  imports: [UsersModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
