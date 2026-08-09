import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('promos')
export class Promo {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 20 })
  code: string;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  discountPercent: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  maxDiscount: number;

  @Column({ type: 'integer', default: 1 })
  maxUsesPerUser: number;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validUntil?: Date;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
