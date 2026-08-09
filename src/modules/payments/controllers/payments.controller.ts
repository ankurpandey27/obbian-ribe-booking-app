import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PaymentsService } from '../services/payments.service';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtPayload } from '../../auth/services/token.service';
import {
  InitiatePaymentDto,
  InitiatePaymentResultDto,
  PaymentReceiptDto,
  RefundResultDto,
  VerifyPaymentDto,
  VerifyPaymentResultDto,
  WebhookResultDto,
} from '../dto/payments.dto';
import { RidesService } from '../../rides/services/rides.service';
import { Public } from '../../../common/auth/decorators';
import { ApiErrorDto } from '../../../common/dto/api-error';

@ApiTags('payments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiErrorDto,
  description: 'Missing/invalid token',
})
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly ridesService: RidesService,
  ) {}

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initiate payment for a ride (async via queue)' })
  @ApiCreatedResponse({ type: InitiatePaymentResultDto })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiatePaymentDto,
  ) {
    const ride = await this.ridesService.getRide(dto.rideId);
    if (ride.riderId !== user.sub) {
      return { error: 'Not your ride' };
    }
    const payment = await this.paymentsService.initiatePayment(
      dto.rideId,
      user.sub,
      dto.amount ?? Number(ride.totalFare ?? ride.estimatedFare),
      dto.method,
    );
    return {
      paymentId: payment.id,
      status: payment.status,
      amount: Number(payment.amount),
      orderId: payment.gatewayOrderId ?? null,
    };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify Razorpay signature after client checkout' })
  @ApiOkResponse({ type: VerifyPaymentResultDto })
  async verify(
    @CurrentUser() _user: JwtPayload,
    @Body() dto: VerifyPaymentDto,
  ) {
    return this.paymentsService.verifyPayment(
      dto.rideId,
      dto.razorpayOrderId,
      dto.razorpayPaymentId,
      dto.signature,
    );
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay webhook endpoint (signature verified)' })
  @ApiOkResponse({ type: WebhookResultDto })
  @ApiQuery({
    name: 'signature',
    required: false,
    description: 'Razorpay signature',
  })
  async webhook(
    @Body() body: unknown,
    @Query('signature') signature?: string,
    @Query('x-razorpay-signature') headerSignature?: string,
  ) {
    return this.paymentsService.handleWebhook(
      body,
      signature ?? headerSignature,
    );
  }

  @Get(':rideId')
  @ApiOperation({ summary: 'Payment + receipt for a ride' })
  @ApiOkResponse({ type: PaymentReceiptDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Payment not found' })
  async getPayment(@Param('rideId') rideId: string) {
    const payment = await this.paymentsService.getPayment(rideId);
    return {
      status: payment.status,
      amount: Number(payment.amount),
      method: payment.method,
      transactionId: payment.gatewayPaymentId ?? null,
      paidAt: payment.paidAt,
      receipt: {
        rideId,
        amount: Number(payment.amount),
        currency: payment.currency,
      },
    };
  }

  @Post(':rideId/refund')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund a completed payment' })
  @ApiOkResponse({ type: RefundResultDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({ type: ApiErrorDto, description: 'Payment not found' })
  async refund(@Param('rideId') rideId: string) {
    return this.paymentsService.refund(rideId);
  }
}
