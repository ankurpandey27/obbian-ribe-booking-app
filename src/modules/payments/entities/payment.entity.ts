import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  PaymentMethodValue,
  PaymentStatusValue,
} from '../../../shared/types/common';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  rideId: string;

  @Index()
  @Column('uuid')
  userId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ length: 3, default: 'INR' })
  currency: string;

  @Column({
    type: 'enum',
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'],
    default: 'PENDING',
  })
  status: PaymentStatusValue;

  @Column({
    type: 'enum',
    enum: ['UPI', 'CASH', 'WALLET', 'CARD'],
    default: 'UPI',
  })
  method: PaymentMethodValue;

  @Column({ length: 50, default: 'RAZORPAY' })
  gateway: string;

  @Index()
  @Column({ length: 255, nullable: true })
  gatewayOrderId?: string;

  @Column({ length: 255, nullable: true })
  gatewayPaymentId?: string;

  @Column({ nullable: true })
  failureReason?: string;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  refundedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
