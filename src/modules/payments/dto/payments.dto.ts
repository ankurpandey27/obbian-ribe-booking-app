import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethodValue } from '../../../shared/types/common';

export class InitiatePaymentDto {
  @ApiProperty({ example: 'ride-uuid' })
  @IsUUID()
  rideId: string;

  @ApiPropertyOptional({ example: 250 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  amount?: number;

  @ApiPropertyOptional({
    enum: ['UPI', 'CASH', 'WALLET', 'CARD'],
    default: 'UPI',
  })
  @IsOptional()
  @IsEnum(['UPI', 'CASH', 'WALLET', 'CARD'])
  method?: PaymentMethodValue;
}

export class VerifyPaymentDto {
  @ApiProperty({ example: 'ride-uuid' })
  @IsUUID()
  rideId: string;

  @ApiProperty({ example: 'order_xxxx' })
  @IsString()
  razorpayOrderId: string;

  @ApiProperty({ example: 'pay_xxxx' })
  @IsString()
  razorpayPaymentId: string;

  @ApiProperty({ example: 'signature-string' })
  @IsString()
  signature: string;
}

/* ------------------------------ responses ------------------------------ */

export class InitiatePaymentResultDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  paymentId: string;

  @ApiProperty({
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'],
  })
  status: string;

  @ApiProperty({ example: 718.5 })
  amount: number;

  @ApiProperty({ example: 'order_xxxx', nullable: true })
  orderId: string | null;
}

export class VerifyPaymentResultDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'pay_xxxx' })
  transactionId: string;
}

export class PaymentReceiptDto {
  @ApiProperty({
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'],
  })
  status: string;

  @ApiProperty({ example: 718.5 })
  amount: number;

  @ApiProperty({ enum: ['UPI', 'CASH', 'WALLET', 'CARD'] })
  method: string;

  @ApiProperty({ example: 'pay_xxxx', nullable: true })
  transactionId: string | null;

  @ApiProperty({ example: '2026-08-08T16:30:00.000Z', nullable: true })
  paidAt: Date | null;

  @ApiProperty({
    type: Object,
    example: { rideId: 'a1b2c3d4-...', amount: 718.5, currency: 'INR' },
  })
  receipt: Record<string, unknown>;
}

export class RefundResultDto {
  @ApiProperty({ example: true })
  refunded: boolean;
}

export class WebhookResultDto {
  @ApiProperty({ example: true })
  received: boolean;
}
