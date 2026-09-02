import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/decorators';
import { JwtPayload } from '../auth/token.service';
import {
  AssignIncidentDto,
  CreateIncidentDto,
  DisputePenaltyDto,
  IncidentResponseDto,
  PenaltyResponseDto,
  ResolveIncidentDto,
} from './dto/ops.dto';
import { CancellationPenaltiesService } from './cancellation-penalties.service';
import { IncidentsService } from './incidents.service';

@ApiTags('ops')
@ApiBearerAuth()
@Controller('ops')
export class OpsController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly penalties: CancellationPenaltiesService,
  ) {}

  @Post('incidents')
  @ApiOperation({ summary: 'Open a safety or support incident' })
  @ApiCreatedResponse({ type: IncidentResponseDto })
  async createIncident(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateIncidentDto,
  ) {
    return this.serializeIncident(await this.incidents.create(user.sub, dto));
  }

  @Get('incidents/mine')
  @ApiOperation({ summary: 'List incidents reported by the current user' })
  @ApiOkResponse({ type: [IncidentResponseDto] })
  async myIncidents(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
  ) {
    const rows = await this.incidents.listForReporter(
      user.sub,
      Number(limit) || 50,
    );
    return rows.map((row) => this.serializeIncident(row));
  }

  @Get('incidents/queue')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List unresolved incidents' })
  @ApiOkResponse({ type: [IncidentResponseDto] })
  async incidentQueue(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const rows = await this.incidents.queue(
      Number(limit) || 50,
      Number(offset) || 0,
    );
    return rows.map((row) => this.serializeIncident(row));
  }

  @Put('incidents/:id/assign')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Assign an incident to an ops user' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: IncidentResponseDto })
  async assignIncident(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignIncidentDto,
  ) {
    return this.serializeIncident(
      await this.incidents.assign(id, dto.assignedToUserId),
    );
  }

  @Put('incidents/:id/resolve')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Resolve or dismiss an incident' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: IncidentResponseDto })
  async resolveIncident(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
  ) {
    return this.serializeIncident(
      await this.incidents.resolve(id, user.sub, dto),
    );
  }

  @Get('penalties/mine')
  @ApiOperation({ summary: 'List own cancellation penalties' })
  @ApiOkResponse({ type: [PenaltyResponseDto] })
  async myPenalties(@CurrentUser() user: JwtPayload) {
    const rows = await this.penalties.listForUser(user.sub);
    return rows.map((row) => this.serializePenalty(row));
  }

  @Post('penalties/:id/dispute')
  @ApiOperation({
    summary: 'Open an incident to dispute a cancellation penalty',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async disputePenalty(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputePenaltyDto,
  ) {
    return this.penalties.dispute(id, user.sub, dto.reason);
  }

  @Put('penalties/:id/waive')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Waive a cancellation penalty' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async waivePenalty(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DisputePenaltyDto,
  ) {
    return this.serializePenalty(
      await this.penalties.waive(id, user.sub, dto.reason),
    );
  }

  private serializeIncident(
    row: typeof import('../../common/database/schema').incidents.$inferSelect,
  ): IncidentResponseDto {
    return {
      id: row.id,
      reference: row.reference,
      rideId: row.rideId,
      reportedByUserId: row.reportedByUserId,
      againstUserId: row.againstUserId,
      incidentType: row.incidentType,
      severity: row.severity,
      status: row.status,
      description: row.description,
      assignedToUserId: row.assignedToUserId,
      resolution: row.resolution,
      compensationPaise: row.compensationPaise,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }

  private serializePenalty(
    row: typeof import('../../common/database/schema').cancellationPenalties.$inferSelect,
  ): PenaltyResponseDto {
    return {
      id: row.id,
      rideId: row.rideId,
      role: row.role,
      offenceIndex: row.offenceIndex,
      penaltyPaise: row.penaltyPaise,
      isWaived: row.isWaived,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
