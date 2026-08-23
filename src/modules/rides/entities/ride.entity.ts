import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  CancellationReasonValue,
  PaymentMethodValue,
  PaymentStatusValue,
  RideStatusValue,
  RideTypeValue,
} from '../../../shared/types/common';

@Index('idx_rides_rider_status_created', {
  synchronize: false,
})
@Index('idx_rides_driver_status_created', { synchronize: false })
@Entity('rides')
export class Ride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  riderId: string;

  @Index()
  @Column('uuid', { nullable: true })
  driverId?: string;

  @Column({
    type: 'enum',
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @Index()
  @Column({
    type: 'enum',
    enum: [
      'REQUESTED',
      'MATCHING',
      'ACCEPTED',
      'ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ],
    default: 'REQUESTED',
  })
  status: RideStatusValue;

  @Column({ type: 'double precision' })
  pickupLat: number;
  @Column({ type: 'double precision' })
  pickupLon: number;
  @Column({ nullable: true })
  pickupAddress?: string;

  @Column({ type: 'double precision' })
  dropoffLat: number;
  @Column({ type: 'double precision' })
  dropoffLon: number;
  @Column({ nullable: true })
  dropoffAddress?: string;

  @Column({ length: 50, default: 'Delhi' })
  city: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  estimatedFare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  totalFare?: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  surgeMultiplier: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  distanceKm: number;

  @Column({ type: 'integer', default: 0 })
  durationMin: number;

  @Column({ nullable: true })
  promoCode?: string;
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  promoDiscount: number;

  @Column({
    type: 'enum',
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'],
    default: 'PENDING',
  })
  paymentStatus: PaymentStatusValue;

  @Column({
    type: 'enum',
    enum: ['UPI', 'CASH', 'WALLET', 'CARD'],
    default: 'UPI',
  })
  paymentMethod: PaymentMethodValue;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt?: Date;
  @Column({ type: 'timestamptz', nullable: true })
  arrivedAt?: Date;
  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;
  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date;

  @Column({
    type: 'enum',
    enum: ['USER_CANCELLED', 'DRIVER_CANCELLED', 'NO_DRIVER_FOUND', 'SYSTEM'],
    nullable: true,
  })
  cancellationReason?: CancellationReasonValue;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  cancellationFee: number;

  @Column({ type: 'integer', nullable: true })
  riderRating?: number;
  @Column({ type: 'integer', nullable: true })
  driverRating?: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
