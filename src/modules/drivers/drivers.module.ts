import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DriversController } from './controllers/drivers.controller';
import { DriversService } from './services/drivers.service';
import { Driver } from './entities/driver.entity';
import { GeoService } from '../../common/redis/geo.service';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Driver]), UsersModule],
  controllers: [DriversController],
  providers: [DriversService, GeoService],
  exports: [DriversService],
})
export class DriversModule {}
