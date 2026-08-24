import { Module } from '@nestjs/common';
import { DriversController } from './controllers/drivers.controller';
import { DriversService } from './services/drivers.service';
import { GeoService } from '../../common/redis/geo.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [DriversController],
  providers: [DriversService, GeoService],
  exports: [DriversService],
})
export class DriversModule {}
