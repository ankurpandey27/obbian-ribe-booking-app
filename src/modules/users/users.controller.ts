import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import {
  SavedLocationDto,
  SavedLocationListResultDto,
  SavedLocationSaveResultDto,
  UpdatedUserResultDto,
  UpdateProfileDto,
  UserProfileDto,
} from './dto/users.dto';
import { JwtPayload } from '../auth/token.service';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';

@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get own profile' })
  @ApiOkResponse({ type: UserProfileDto })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const profile = await this.usersService.findById(user.sub);
    if (!profile) throw new NotFoundException('User profile not found');
    const { firstName, lastName, email, phoneNumber, profileImageUrl, rating } =
      profile;
    return {
      name: `${firstName ?? ''} ${lastName ?? ''}`.trim(),
      email,
      phone: phoneNumber,
      profileImage: profileImageUrl,
      rating: Number(rating),
    };
  }

  @Put('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update profile' })
  @ApiCreatedResponse({ type: UpdatedUserResultDto })
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    const updated = await this.usersService.updateProfile(user.sub, dto);
    return { updatedUser: updated };
  }

  @Get('saved-locations')
  @ApiOperation({ summary: 'List saved locations' })
  @ApiOkResponse({ type: SavedLocationListResultDto })
  async getSavedLocations(@CurrentUser() user: JwtPayload) {
    const locations = await this.usersService.listSavedLocations(user.sub);
    return { locations };
  }

  @Post('saved-locations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a location' })
  @ApiCreatedResponse({ type: SavedLocationSaveResultDto })
  async saveLocation(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SavedLocationDto,
  ) {
    const saved = await this.usersService.saveLocation(user.sub, dto);
    return { saved };
  }
}
