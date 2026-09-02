import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Body,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/decorators';
import { JwtPayload } from '../auth/token.service';
import { AdminService } from './admin.service';
import {
  RefundDto,
  RetryDlqDto,
  RetryDlqTypeDto,
  SuspendUserDto,
} from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('outbox/dlq')
  @ApiOperation({ summary: 'List failed outbox events' })
  listDlq(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.admin.listDlq(Number(limit) || 50, Number(offset) || 0);
  }

  @Get('outbox/dlq/summary')
  @ApiOperation({ summary: 'Summarize failed outbox events' })
  dlqSummary() {
    return this.admin.dlqSummary();
  }

  @Post('outbox/dlq/retry')
  @ApiOperation({ summary: 'Retry selected failed outbox events' })
  retryDlq(@CurrentUser() user: JwtPayload, @Body() dto: RetryDlqDto) {
    return this.admin.retryDlq(dto.ids, user.sub);
  }

  @Post('outbox/dlq/retry-type')
  @ApiOperation({ summary: 'Retry failed outbox events by type' })
  retryDlqType(@CurrentUser() user: JwtPayload, @Body() dto: RetryDlqTypeDto) {
    return this.admin.retryDlqType(dto.type, user.sub);
  }

  @Get('compliance/review-queue')
  @ApiOperation({ summary: 'List the driver compliance review queue' })
  complianceQueue(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.admin.listComplianceQueue(
      Number(limit) || 50,
      Number(offset) || 0,
    );
  }

  @Post('rides/:rideId/refund')
  @ApiOperation({ summary: 'Refund a completed ride payment' })
  refund(
    @CurrentUser() user: JwtPayload,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: RefundDto,
  ) {
    return this.admin.refund(rideId, user.sub, dto.reason);
  }

  @Put('users/:userId/status')
  @ApiOperation({ summary: 'Suspend, ban, or reactivate an account' })
  setAccountStatus(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.admin.setAccountStatus(userId, user.sub, {
      ...dto,
      suspendedUntil: dto.suspendedUntil
        ? new Date(dto.suspendedUntil)
        : undefined,
    });
  }

  @Get('invoices/:financialYear/gaps')
  @ApiOperation({ summary: 'Audit invoice sequence gaps for a financial year' })
  invoiceGaps(@Param('financialYear') financialYear: string) {
    return this.admin.findInvoiceGaps(financialYear);
  }

  @Get('ledger/drift')
  @ApiOperation({ summary: 'Report wallet cache drift' })
  ledgerDrift(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.admin.findLedgerDrift(
      Number(limit) || 500,
      Number(offset) || 0,
    );
  }

  @Post('ledger/:driverId/repair')
  @ApiOperation({ summary: 'Repair one wallet cache from ledger truth' })
  repairLedger(
    @CurrentUser() user: JwtPayload,
    @Param('driverId', ParseUUIDPipe) driverId: string,
    @Body() dto: RefundDto,
  ) {
    return this.admin.repairLedgerDrift(driverId, user.sub, dto.reason);
  }
}
