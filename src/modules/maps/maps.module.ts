import { Module } from '@nestjs/common';
import { MapsController } from './maps.controller';
import { MapsService } from './services/maps.service';

@Module({
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
