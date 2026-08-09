import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RatingsService } from '../services/ratings.service';
import { RatingAggregateDto } from '../dto/ratings.dto';
import { ApiErrorDto } from '../../../common/dto/api-error';

@ApiTags('ratings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorDto,
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
    @Param() _: never,
  ): Promise<RatingAggregateDto> {
    return this.ratingsService.getAggregate(userId, 'RIDER');
  }
}
