import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { AnalyticsSummaryDto } from './dto/analytics.dto';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';
import { Roles } from '../../common/auth/decorators';

@ApiTags('analytics')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Ride/rev/fleet aggregates for the last N days (dashboard)',
  })
  @ApiOkResponse({ type: AnalyticsSummaryDto })
  @ApiQuery({
    name: 'days',
    example: 30,
    required: false,
    description: '1–365',
  })
  async summary(@Query('days') days?: string): Promise<AnalyticsSummaryDto> {
    const clamped = Math.min(
      Math.max(parseInt(days ?? '30', 10) || 30, 1),
      365,
    );
    return this.analytics.summary(clamped);
  }
}
