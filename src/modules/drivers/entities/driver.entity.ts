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
  user?: User;

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

  /**
   * CACHE of the wallet_ledger tail — never the source of truth.
   * Only WalletLedgerService writes these two; see ADR-012.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  walletBalance: number;

  /** Paise mirror of walletBalance — the value the ledger actually writes. */
  @Column({ type: 'integer', default: 0 })
  walletBalancePaise: number;

  @Column({ length: 20, nullable: true })
  bankAccount?: string;

  @Column({ nullable: true })
  upiId?: string;

  /**
   * Dispatch eligibility (migration 006). false blocks going ONLINE and
   * excludes the driver from matching. Written only by
   * DriverDocumentsService.recomputeEligibility().
   */
  @Column({ type: 'boolean', default: false })
  isComplianceVerified: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  complianceCheckedAt?: Date;

  /**
   * Vehicle currently in service. Compliance is evaluated against THIS
   * vehicle's documents — insurance on a retired vehicle is irrelevant.
   */
  @Column({ type: 'uuid', nullable: true })
  activeVehicleId?: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastLocationUpdateAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  onlineSince?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
