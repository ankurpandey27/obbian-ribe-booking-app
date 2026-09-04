import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { Roles } from '../../common/auth/decorators';
import { CatalogService } from './catalog.service';
import {
  CatalogResponseDto,
  CreateFaqDto,
  CreateRideCategoryDto,
  CreateServiceDto,
  SetCategoryCityDto,
  UpdateFaqDto,
  UpdateRideCategoryDto,
  UpdateServiceDto,
} from './dto/catalog.dto';

@ApiTags('catalog')
@Controller('api/v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Public: read catalog ────────────────────────────────────────────────
  @Get('catalog')
  @Public()
  @ApiOperation({ summary: 'Full service + ride-category catalog for a city' })
  @ApiQuery({ name: 'city', example: 'Hyderabad' })
  @ApiQuery({ name: 'locale', example: 'te-IN', required: false })
  @ApiOkResponse({ type: CatalogResponseDto })
  async getCatalog(
    @Query('city') city = 'Hyderabad',
    @Query('locale') locale = 'te-IN',
  ): Promise<CatalogResponseDto> {
    return this.catalog.getCatalog(city, locale);
  }
}

@ApiTags('catalog-admin')
@ApiBearerAuth()
@Controller('admin/catalog')
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Services ─────────────────────────────────────────────────────────────
  @Post('services')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a service (tab)' })
  async createService(@Body() dto: CreateServiceDto) {
    return this.catalog.createService(dto);
  }

  @Put('services/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update a service' })
  @ApiParam({ name: 'id' })
  async updateService(@Param('id') id: string, @Body() dto: UpdateServiceDto) {
    return this.catalog.updateService(id, dto);
  }

  @Delete('services/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a service' })
  @ApiParam({ name: 'id' })
  async deleteService(@Param('id') id: string) {
    await this.catalog.deleteService(id);
    return { success: true };
  }

  // ── Ride categories ──────────────────────────────────────────────────────
  @Post('ride-categories')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a ride category' })
  async createCategory(@Body() dto: CreateRideCategoryDto) {
    return this.catalog.createCategory(dto);
  }

  @Put('ride-categories/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update a ride category' })
  @ApiParam({ name: 'id' })
  async updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateRideCategoryDto,
  ) {
    return this.catalog.updateCategory(id, dto);
  }

  @Delete('ride-categories/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a ride category' })
  @ApiParam({ name: 'id' })
  async deleteCategory(@Param('id') id: string) {
    await this.catalog.deleteCategory(id);
    return { success: true };
  }

  // ── City availability ────────────────────────────────────────────────────
  @Put('ride-categories/:code/cities/:city')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Set city availability + sort for a category' })
  @ApiParam({ name: 'code', example: 'CABX' })
  @ApiParam({ name: 'city', example: 'Hyderabad' })
  async setCategoryCity(
    @Param('code') code: string,
    @Param('city') city: string,
    @Body() dto: SetCategoryCityDto,
  ) {
    return this.catalog.setCategoryCityAvailability(
      code,
      city,
      dto.isAvailable,
      dto.sortOrder,
    );
  }

  // ── Ride category FAQs (Module 6) ────────────────────────────────────────
  @Get('ride-categories/:code/faqs')
  @Public()
  @ApiOperation({ summary: 'Get FAQs for a ride category' })
  @ApiParam({ name: 'code', example: 'CABX' })
  @ApiQuery({ name: 'locale', example: 'te-IN', required: false })
  async getFaqs(
    @Param('code') code: string,
    @Query('locale') locale = 'te-IN',
  ) {
    return this.catalog.getFaqs(code, locale);
  }

  @Post('ride-categories/faqs')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create a ride-category FAQ' })
  async createFaq(@Body() dto: CreateFaqDto) {
    return this.catalog.createFaq(dto);
  }

  @Put('ride-categories/faqs/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update a ride-category FAQ' })
  @ApiParam({ name: 'id' })
  async updateFaq(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.catalog.updateFaq(id, dto);
  }

  @Delete('ride-categories/faqs/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a ride-category FAQ' })
  @ApiParam({ name: 'id' })
  async deleteFaq(@Param('id') id: string) {
    await this.catalog.deleteFaq(id);
    return { success: true };
  }
}
