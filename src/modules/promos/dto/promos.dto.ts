import { IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ValidatePromoDto {
  @ApiProperty({ example: 'FIRST50' })
  @IsString()
  @MaxLength(20)
  code: string;
}

/* ------------------------------ responses ------------------------------ */

export class PromoValidationDto {
  @ApiProperty({ example: 'FIRST50' })
  code: string;

  @ApiProperty({ example: 50, description: 'Percentage off' })
  discountPercent: number;

  @ApiProperty({ example: 250, description: 'Maximum discount in INR' })
  maxDiscount: number;

  @ApiPropertyOptional({
    example: '2026-08-31T18:29:59.000Z',
    description: 'Promo expiry',
  })
  validUntil?: Date;
}

export class PromoListResultDto {
  @ApiProperty({ type: [PromoValidationDto] })
  promos: PromoValidationDto[];
}
