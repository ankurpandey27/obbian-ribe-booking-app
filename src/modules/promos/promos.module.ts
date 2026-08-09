import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromosController } from './controllers/promos.controller';
import { PromosService } from './services/promos.service';
import { Promo } from './entities/promo.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Promo])],
  controllers: [PromosController],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
