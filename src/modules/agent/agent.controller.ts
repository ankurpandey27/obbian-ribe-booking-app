import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { JwtPayload } from '../auth/token.service';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';
import {
  AgentExecuteRequestDto,
  AgentExecuteResponseDto,
  AgentQuoteRequestDto,
  AgentQuoteResponseDto,
} from './dto/agent.dto';
import { AgentRidesService } from './agent-rides.service';
import { RojuSignatureGuard } from './guards/roju-signature.guard';

/**
 * Agent surface for the Roju voice/chat agent (ADR-00X). The forwarded user
 * JWT identifies the rider; the optional X-Roju-* HMAC tags agent-originated
 * traffic for rate limiting and audit.
 */
@ApiTags('agent')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: ApiEnvelopeDto })
@Controller('agent/rides')
@UseGuards(RojuSignatureGuard)
export class AgentController {
  constructor(private readonly agentRides: AgentRidesService) {}

  @Post('quote')
  @HttpCode(200)
  @ApiOperation({ summary: 'Agent-scoped fare quote with price-lock id' })
  @ApiOkResponse({ type: AgentQuoteResponseDto })
  async quote(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AgentQuoteRequestDto,
  ): Promise<AgentQuoteResponseDto> {
    return this.agentRides.quote(user, dto);
  }

  @Post('execute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Execute a confirmed agent action (idempotent)' })
  @ApiOkResponse({ type: AgentExecuteResponseDto })
  async execute(
    @CurrentUser() user: JwtPayload,
    @Body() dto: AgentExecuteRequestDto,
  ): Promise<AgentExecuteResponseDto> {
    return this.agentRides.execute(user, dto);
  }
}
