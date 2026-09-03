import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/decorators';
import { JwtPayload } from '../auth/token.service';
import {
  InitiatePaymentDto,
  InitiatePaymentResultDto,
  PaymentReceiptDto,
  RefundResultDto,
  VerifyPaymentDto,
  VerifyPaymentResultDto,
  WebhookResultDto,
} from './dto/payments.dto';
import { RidesService } from '../rides/rides.service';
import { RideParticipantGuard } from '../rides/guards/ride-participant.guard';
import { Public } from '../../common/auth/decorators';
import { ApiEnvelopeDto } from '../../common/dto/api-envelope.dto';

@ApiTags('payments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ApiEnvelopeDto,
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
      throw new ForbiddenException('Not your ride');
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
  async webhook(@Body() body: unknown, @Req() req: Request) {
    // Razorpay sends the signature in the x-razorpay-signature HEADER, not the
    // query string. Reading it from the header is what makes verification work
    // and closes the forgery vector a query-param read would leave open.
    const signature = req.headers['x-razorpay-signature'];
    return this.paymentsService.handleWebhook(
      body,
      typeof signature === 'string' ? signature : undefined,
    );
  }

  @Get(':rideId')
  @UseGuards(RideParticipantGuard)
  @ApiOperation({ summary: 'Payment + receipt for a ride' })
  @ApiOkResponse({ type: PaymentReceiptDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Payment not found',
  })
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
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Refund a completed payment (ADMIN only)' })
  @ApiOkResponse({ type: RefundResultDto })
  @ApiParam({ name: 'rideId', example: 'a1b2c3d4-...' })
  @ApiNotFoundResponse({
    type: ApiEnvelopeDto,
    description: 'Payment not found',
  })
  async refund(@Param('rideId') rideId: string) {
    return this.paymentsService.refund(rideId);
  }
}
