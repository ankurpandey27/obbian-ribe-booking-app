import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { RideTypeValue } from '../../../shared/types/common';

/**
 * Fare config — one row per (city, rideType). DB-driven so ops can tune
 * pricing without deploys. All amounts in INR.
 */
@Entity('fare_configs')
@Unique(['city', 'rideType'])
export class FareConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ length: 50 })
  city: string;

  @Column({
    type: 'enum',
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 50 })
  baseFare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 10 })
  perKmRate: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 1 })
  perMinuteRate: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  surgeMultiplier: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 20 })
  minimumFare: number;

  /** Commission kept by platform, rest goes to driver. 0.25 = 25%. */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.25 })
  commissionRate: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
