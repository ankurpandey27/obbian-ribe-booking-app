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
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MessageService } from './message.service';
import { MessageBulkDto, UpsertMessageDto } from './dto/i18n.dto';
import { Roles } from '../auth/decorators';

@ApiTags('i18n')
@ApiBearerAuth()
@Controller('admin/i18n')
export class I18nAdminController {
  constructor(private readonly messages: MessageService) {}

  @Get('messages')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List all message keys' })
  async getAll(): Promise<unknown> {
    return this.messages.getAll();
  }

  @Get('messages/scope')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'List messages for a scope' })
  @ApiQuery({ name: 'scope', example: 'global' })
  async getScope(@Query('scope') scope: string): Promise<unknown> {
    return this.messages.getScope(scope ?? 'global');
  }

  @Put('messages/:key')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Upsert a localized message' })
  @ApiParam({ name: 'key', example: 'ride.status.dispatched' })
  async upsert(
    @Param('key') key: string,
    @Body() dto: UpsertMessageDto,
  ): Promise<unknown> {
    await this.messages.upsert(key, dto.message, dto.scope, dto.description);
    return { success: true, key };
  }

  @Post('messages/bulk')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Bulk upsert messages (seed/restore)' })
  async bulk(@Body() dto: MessageBulkDto): Promise<unknown> {
    await this.messages.bulkUpsert(dto.messages);
    return { success: true, count: dto.messages.length };
  }

  @Delete('messages/:key')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete a message key' })
  @ApiParam({ name: 'key' })
  async remove(@Param('key') key: string): Promise<unknown> {
    await this.messages.remove(key);
    return { success: true };
  }
}
