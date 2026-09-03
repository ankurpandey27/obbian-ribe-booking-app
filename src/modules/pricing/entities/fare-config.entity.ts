import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Fare config — one row per (city, rideType). DB-driven so ops can tune
 * pricing without deploys. All amounts in INR.
 *
 * rideType references ride_categories.code (catalog-driven). Changed from enum
 * to varchar so new categories need no DDL change.
 */
@Entity('fare_configs')
@Unique(['city', 'rideType'])
export class FareConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ length: 50 })
  city: string;

  @Column({ length: 32 })
  rideType: string;

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

  /* ---- fare add-ons (migration 007) — all in INR, like the siblings ---- */

  /** Charged per intermediate stop beyond the single dropoff. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  perExtraStopFare: number;

  /** Charged per waiting minute once freeWaitingMinutes is exhausted. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  perWaitingMinuteFare: number;

  /** Waiting allowance granted before perWaitingMinuteFare starts. */
  @Column({ type: 'integer', default: 5 })
  freeWaitingMinutes: number;

  /** Flat surcharge for rides starting inside the night window. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  nightSurchargeFare: number;

  /**
   * Night window, local hours. Wraps midnight when start > end
   * (23 → 5 means 23:00–04:59).
   */
  @Column({ type: 'integer', default: 23 })
  nightStartHour: number;

  @Column({ type: 'integer', default: 5 })
  nightEndHour: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
