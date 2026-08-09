import { ApiProperty } from '@nestjs/swagger';

export class RatingBreakdownDto {
  @ApiProperty({ example: 5 })
  star: number;

  @ApiProperty({ example: 92 })
  count: number;
}

export class RatingAggregateDto {
  @ApiProperty({ example: 4.8 })
  averageRating: number;

  @ApiProperty({ example: 118 })
  totalReviews: number;

  @ApiProperty({ type: [RatingBreakdownDto] })
  breakdown: RatingBreakdownDto[];
}
