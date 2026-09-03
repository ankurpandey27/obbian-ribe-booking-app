import { Module } from '@nestjs/common';
import {
  CatalogController,
  CatalogAdminController,
} from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Catalog module — DB-backed service + ride-category catalog.
 * Replaces the hardcoded rideType enum with config-driven catalog tables.
 */
@Module({
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
