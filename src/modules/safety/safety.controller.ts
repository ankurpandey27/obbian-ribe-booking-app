import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/token.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { SafetyService } from './safety.service';
import { Roles } from '../../common/auth/decorators';
import { RaiseSosDto } from './dto/safety.dto';

/**
 * SOS intake. Reachable from the agent (keyword/explicit) and the rider app
 * panic button. Global throttle applies; no additional rate limit by design.
 */
@ApiTags('safety')
@ApiBearerAuth()
@Controller('safety')
@UseGuards(JwtAuthGuard)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Post('sos')
  @HttpCode(202)
  @ApiOperation({ summary: 'Raise an SOS (durable event + ops fan-out)' })
  @ApiOkResponse({
    schema: {
      example: { accepted: true, eventId: 'uuid', emergencyNotified: true },
    },
  })
  async raiseSos(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RaiseSosDto,
  ): Promise<{
    accepted: boolean;
    eventId: string;
    emergencyNotified: boolean;
  }> {
    const { eventId, emergencyNotified } = await this.safety.raiseSos(
      user.sub,
      dto,
    );
    return { accepted: true, eventId, emergencyNotified };
  }
}

/** Admin: SOS event management. */
@ApiTags('safety-admin')
@ApiBearerAuth()
@Controller('admin/safety')
export class SafetyAdminController {
  constructor(private readonly safety: SafetyService) {}

  @Get('events/open')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List open SOS events' })
  @ApiQuery({ name: 'limit', example: 50, required: false })
  async getOpenEvents(@Query('limit') limit = 50) {
    return this.safety.getOpenEvents(Number(limit));
  }

  @Patch('events/:id/acknowledge')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Acknowledge an SOS event' })
  @ApiParam({ name: 'id' })
  async acknowledge(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.safety.acknowledge(id, user.sub);
  }
}
