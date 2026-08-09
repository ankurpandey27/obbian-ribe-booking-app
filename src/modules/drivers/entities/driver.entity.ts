import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { DriverStatusValue, RideTypeValue } from '../../../shared/types/common';

@Entity('drivers')
export class Driver {
  @PrimaryColumn('uuid')
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ length: 50, unique: true })
  licenseNumber: string;

  @Column({ length: 50, unique: true })
  vehicleRegistration: string;

  @Column({ length: 100, nullable: true })
  vehicleModel?: string;

  @Column({ length: 20, nullable: true })
  vehicleColor?: string;

  @Column({
    type: 'enum',
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  vehicleType: RideTypeValue;

  @Index()
  @Column({
    type: 'enum',
    enum: ['ONLINE', 'OFFLINE', 'ON_RIDE'],
    default: 'OFFLINE',
  })
  status: DriverStatusValue;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number;

  @Column({ type: 'integer', default: 0 })
  totalRides: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 100.0 })
  completionRate: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 100.0 })
  acceptanceRate: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  walletBalance: number;

  @Column({ length: 20, nullable: true })
  bankAccount?: string;

  @Column({ nullable: true })
  upiId?: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastLocationUpdateAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  onlineSince?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
