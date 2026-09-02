import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PromosService } from './promos.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtPayload } from '../auth/token.service';
import {
  PromoListResultDto,
  PromoValidationDto,
  ValidatePromoDto,
} from './dto/promos.dto';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';

@ApiTags('promos')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
  description: 'Missing/invalid token',
})
@Controller('promo')
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate a promo code for the current user' })
  @ApiOkResponse({ type: PromoValidationDto })
  @ApiBadRequestResponse({
    type: ApiEnvelopeDto,
    description: 'Promo not yet active / expired',
  })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Invalid promo code',
  })
  validate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ValidatePromoDto,
  ): Promise<PromoValidationDto> {
    return this.promosService.validate(dto.code, user.sub);
  }

  @Get('available')
  @ApiOperation({ summary: 'List currently available promos' })
  @ApiOkResponse({ type: PromoListResultDto })
  async available(): Promise<PromoListResultDto> {
    const promos = await this.promosService.listAvailable();
    return { promos };
  }
}
