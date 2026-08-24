import { Module } from '@nestjs/common';
import { PromosController } from './controllers/promos.controller';
import { PromosService } from './services/promos.service';

@Module({
  controllers: [PromosController],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
