/** Shared enums and primitives across modules. */

export const RideStatus = {
  REQUESTED: 'REQUESTED',
  MATCHING: 'MATCHING',
  ACCEPTED: 'ACCEPTED',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type RideStatusValue = (typeof RideStatus)[keyof typeof RideStatus];

export const RideType = {
  CABX_SAVER: 'CABX_SAVER',
  CABX: 'CABX',
  CABXL: 'CABXL',
  COMFORT: 'COMFORT',
  AUTO: 'AUTO',
  TWO_WHEELER: 'TWO_WHEELER',
} as const;
export type RideTypeValue = (typeof RideType)[keyof typeof RideType];

export const DriverStatus = {
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
  ON_RIDE: 'ON_RIDE',
} as const;
export type DriverStatusValue =
  (typeof DriverStatus)[keyof typeof DriverStatus];

export const UserRole = {
  RIDER: 'RIDER',
  DRIVER: 'DRIVER',
  ADMIN: 'ADMIN',
} as const;
export type UserRoleValue = (typeof UserRole)[keyof typeof UserRole];

export const PaymentStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatusValue =
  (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentMethod = {
  UPI: 'UPI',
  CASH: 'CASH',
  WALLET: 'WALLET',
  CARD: 'CARD',
} as const;
export type PaymentMethodValue =
  (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const CancellationReason = {
  USER_CANCELLED: 'USER_CANCELLED',
  DRIVER_CANCELLED: 'DRIVER_CANCELLED',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
  SYSTEM: 'SYSTEM',
} as const;
export type CancellationReasonValue =
  (typeof CancellationReason)[keyof typeof CancellationReason];

/** Point of interest — lat/lon + human address. */
export interface GeoPoint {
  lat: number;
  lon: number;
  address?: string;
}

/** A route between two points (from maps provider). */
export interface RouteInfo {
  distanceKm: number;
  durationMin: number;
  polyline?: string;
}
