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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../auth/token.service';
import {
  NotificationPreferencesDto,
  RegisterDeviceDto,
} from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('devices')
  @ApiOperation({ summary: 'Register or update a push device' })
  @ApiCreatedResponse()
  registerDevice(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.notifications.registerDevice(user.sub, dto);
  }

  @Get('devices')
  @ApiOperation({ summary: 'List the current user devices' })
  @ApiOkResponse()
  listDevices(@CurrentUser() user: JwtPayload) {
    return this.notifications.listDevices(user.sub);
  }

  @Delete('devices/:deviceId')
  @ApiOperation({ summary: 'Remove a push device' })
  removeDevice(
    @CurrentUser() user: JwtPayload,
    @Param('deviceId') deviceId: string,
  ) {
    return this.notifications.removeDevice(user.sub, deviceId);
  }

  @Get()
  @ApiOperation({ summary: 'List in-app notifications' })
  @ApiOkResponse()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.notifications.list(
      user.sub,
      Number(limit) || 50,
      Number(offset) || 0,
    );
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark an in-app notification read' })
  markRead(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.notifications.markRead(user.sub, id);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Read notification channel preferences' })
  getPreferences(@CurrentUser() user: JwtPayload) {
    return this.notifications.getPreferences(user.sub);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update notification channel preferences' })
  setPreferences(
    @CurrentUser() user: JwtPayload,
    @Body() dto: NotificationPreferencesDto,
  ) {
    return this.notifications.setPreferences(user.sub, dto);
  }
}
