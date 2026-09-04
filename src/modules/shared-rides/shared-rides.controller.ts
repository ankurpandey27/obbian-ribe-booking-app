import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { JwtPayload } from '../auth/token.service';
import { Roles } from '../../common/auth/decorators';
import { SharedRideService } from './shared-rides.service';
import { CreateGroupDto, CreatePoolDto } from './dto/shared-rides.dto';

@ApiTags('shared-rides')
@ApiBearerAuth()
@Controller('api/v1')
export class SharedRideController {
  constructor(private readonly sharedRides: SharedRideService) {}

  // ── Pools ────────────────────────────────────────────────────────────────
  @Post('rides/pool')
  @ApiOperation({ summary: 'Join or create a shared ride pool' })
  async joinOrCreatePool(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePoolDto,
  ) {
    return this.sharedRides.joinOrCreatePool({ ...dto, riderId: user.sub });
  }

  @Get('pools/:poolId')
  @ApiOperation({ summary: 'Get pool details' })
  @ApiParam({ name: 'poolId' })
  async getPool(
    @CurrentUser() user: JwtPayload,
    @Param('poolId') poolId: string,
  ) {
    const pool = await this.sharedRides.getPool(poolId);
    if (!pool) throw new NotFoundException('Pool not found');
    // PII GUARD: only confirmed members of the pool may see the full member
    // roster (rider UUIDs + seat allocations). Non-members get pool metadata
    // without member details.
    const members = await this.sharedRides.getPoolMembers(poolId);
    const isMember = members.some((m) => m.riderId === user.sub);
    if (isMember) return { ...pool, members };
    // Strip PII: return pool without member list
    const { bookedSeats, maxSeats } = pool;
    return { ...pool, bookedSeats, maxSeats, members: [] };
  }

  @Post('pools/:poolId/lock')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Lock a pool (ADMIN)' })
  @ApiParam({ name: 'poolId' })
  async lockPool(@Param('poolId') poolId: string) {
    return this.sharedRides.lockPool(poolId);
  }

  // ── Groups ───────────────────────────────────────────────────────────────
  @Post('groups')
  @ApiOperation({ summary: 'Create a group' })
  async createGroup(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGroupDto,
  ) {
    return this.sharedRides.createGroup({ ...dto, ownerId: user.sub });
  }

  @Get('groups/:groupId')
  @ApiOperation({ summary: 'Get group details' })
  @ApiParam({ name: 'groupId' })
  async getGroup(
    @CurrentUser() user: JwtPayload,
    @Param('groupId') groupId: string,
  ) {
    const group = await this.sharedRides.getGroup(groupId);
    if (!group) throw new NotFoundException('Group not found');
    // Only group members may see group details; return limited info to others
    const members = await this.sharedRides.getGroupMembers(groupId);
    const isMember = members.some((m) => m.userId === user.sub);
    if (isMember || group.type === 'PUBLIC') return { ...group, members };
    return {
      id: group.id,
      name: group.name,
      type: group.type,
      city: group.city,
    };
  }
}
