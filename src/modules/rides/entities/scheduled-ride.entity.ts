import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RideTypeValue } from '../../../shared/types/common';

export type ScheduledRideStatus = 'PENDING' | 'DISPATCHED' | 'CANCELLED';

@Entity('scheduled_rides')
export class ScheduledRide {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  riderId: string;

  @Column('uuid', { nullable: true })
  rideId?: string;

  @Column({ type: 'double precision' })
  pickupLat: number;
  @Column({ type: 'double precision' })
  pickupLon: number;
  @Column({ type: 'double precision' })
  dropoffLat: number;
  @Column({ type: 'double precision' })
  dropoffLon: number;

  @Column({
    type: 'enum',
    enum: ['CABX_SAVER', 'CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  })
  rideType: RideTypeValue;

  @Column({ length: 50, default: 'Delhi' })
  city: string;

  @Column({ type: 'timestamptz' })
  scheduledFor: Date;

  @Column({ length: 20, default: 'PENDING' })
  status: ScheduledRideStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
