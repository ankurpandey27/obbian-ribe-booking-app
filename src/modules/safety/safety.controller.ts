import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/token.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { SafetyService } from './safety.service';
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
  @ApiOkResponse({ schema: { example: { accepted: true, eventId: 'uuid' } } })
  async raiseSos(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RaiseSosDto,
  ): Promise<{ accepted: boolean; eventId: string }> {
    const { eventId } = await this.safety.raiseSos(user.sub, dto);
    return { accepted: true, eventId };
  }
}
