import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RatingsService } from './ratings.service';
import { RatingAggregateDto } from './dto/ratings.dto';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../auth/token.service';

@ApiTags('ratings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('users')
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  @Get(':userId/rating')
  @ApiOperation({ summary: 'Aggregate rating for a user (rider or driver)' })
  @ApiOkResponse({ type: RatingAggregateDto })
  @ApiParam({ name: 'userId', example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  async getRating(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<RatingAggregateDto> {
    // IDOR GUARD: a user may only read their own rating unless they are ADMIN.
    if (user.sub !== userId && user.role !== 'ADMIN') {
      throw new ForbiddenException('Not permitted to view this rating');
    }
    return this.ratingsService.getAggregate(userId, 'RIDER');
  }
}
