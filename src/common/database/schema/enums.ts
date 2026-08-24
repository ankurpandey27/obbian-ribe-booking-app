import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enum types — names/types match the hand-written migrations
 * (001/002/003) exactly. These declarations give Drizzle typed columns;
 * they are NEVER pushed (drizzle-kit push is disabled — migrations are
 * the single source of truth for DDL).
 */
export const userRole = pgEnum('user_role', ['RIDER', 'DRIVER', 'ADMIN']);
export const rideType = pgEnum('ride_type', [
  'CABX_SAVER',
  'CABX',
  'CABXL',
  'COMFORT',
  'AUTO',
  'TWO_WHEELER',
]);
export const rideStatus = pgEnum('ride_status', [
  'REQUESTED',
  'MATCHING',
  'ACCEPTED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export const driverStatus = pgEnum('driver_status', [
  'ONLINE',
  'OFFLINE',
  'ON_RIDE',
]);
export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'REFUNDED',
]);
export const paymentMethod = pgEnum('payment_method', [
  'UPI',
  'CASH',
  'WALLET',
  'CARD',
]);
export const cancellationReason = pgEnum('cancellation_reason', [
  'USER_CANCELLED',
  'DRIVER_CANCELLED',
  'NO_DRIVER_FOUND',
  'SYSTEM',
]);
export const outboxStatus = pgEnum('outbox_status', [
  'PENDING',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
]);

export const UserRoleValue = userRole.enumValues;
export const RideTypeValue = rideType.enumValues;
export const RideStatusValue = rideStatus.enumValues;
export const DriverStatusValue = driverStatus.enumValues;
