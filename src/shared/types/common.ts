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
  REFUNDING: 'REFUNDING',
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

/* ------------------------------------------------------------------ *
 * Finance (migration 005)
 * ------------------------------------------------------------------ */

export const LedgerEntryType = {
  RIDE_EARNING: 'RIDE_EARNING',
  COMMISSION_DEBIT: 'COMMISSION_DEBIT',
  SETTLEMENT_DEBIT: 'SETTLEMENT_DEBIT',
  SETTLEMENT_REVERSAL: 'SETTLEMENT_REVERSAL',
  INCENTIVE_CREDIT: 'INCENTIVE_CREDIT',
  PENALTY_DEBIT: 'PENALTY_DEBIT',
  REFUND_ADJUSTMENT: 'REFUND_ADJUSTMENT',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  TIP_CREDIT: 'TIP_CREDIT',
} as const;
export type LedgerEntryTypeValue =
  (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

/**
 * Credit (+1) vs debit (-1) direction per entry type — the single source of
 * truth for ledger arithmetic. Declared as a total Record so adding a new
 * LedgerEntryType without declaring its direction is a compile error.
 *
 * MANUAL_ADJUSTMENT is +1 by declaration; callers pass a negative amount to
 * express a correction downward (the only entry type allowed to do so).
 */
export const LEDGER_SIGN: Record<LedgerEntryTypeValue, 1 | -1> = {
  RIDE_EARNING: 1,
  COMMISSION_DEBIT: -1,
  SETTLEMENT_DEBIT: -1,
  SETTLEMENT_REVERSAL: 1,
  INCENTIVE_CREDIT: 1,
  PENALTY_DEBIT: -1,
  REFUND_ADJUSTMENT: -1,
  MANUAL_ADJUSTMENT: 1,
  TIP_CREDIT: 1,
};

export const SettlementStatus = {
  PENDING: 'PENDING',
  LEDGERED: 'LEDGERED',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type SettlementStatusValue =
  (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  CANCELLED: 'CANCELLED',
} as const;
export type InvoiceStatusValue =
  (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

/* ------------------------------------------------------------------ *
 * Compliance (migration 006)
 * ------------------------------------------------------------------ */

export const DriverDocumentType = {
  DRIVING_LICENSE: 'DRIVING_LICENSE',
  VEHICLE_REGISTRATION: 'VEHICLE_REGISTRATION',
  VEHICLE_INSURANCE: 'VEHICLE_INSURANCE',
  VEHICLE_FITNESS: 'VEHICLE_FITNESS',
  VEHICLE_PERMIT: 'VEHICLE_PERMIT',
  POLLUTION_CERTIFICATE: 'POLLUTION_CERTIFICATE',
  AADHAAR: 'AADHAAR',
  PAN: 'PAN',
  PROFILE_PHOTO: 'PROFILE_PHOTO',
  BANK_PROOF: 'BANK_PROOF',
} as const;
export type DriverDocumentTypeValue =
  (typeof DriverDocumentType)[keyof typeof DriverDocumentType];

export const DocumentStatus = {
  PENDING: 'PENDING',
  IN_REVIEW: 'IN_REVIEW',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type DocumentStatusValue =
  (typeof DocumentStatus)[keyof typeof DocumentStatus];

/**
 * Documents that must ALL be VERIFIED (and unexpired) before a driver may go
 * ONLINE. Kept minimal on purpose — every extra slot is onboarding friction.
 * Vehicle-scoped entries are validated against the driver's ACTIVE vehicle.
 */
export const REQUIRED_DRIVER_DOCUMENTS: readonly DriverDocumentTypeValue[] = [
  DriverDocumentType.DRIVING_LICENSE,
  DriverDocumentType.VEHICLE_REGISTRATION,
  DriverDocumentType.VEHICLE_INSURANCE,
] as const;

/** Document slots that belong to a vehicle rather than the person. */
export const VEHICLE_SCOPED_DOCUMENTS: readonly DriverDocumentTypeValue[] = [
  DriverDocumentType.VEHICLE_REGISTRATION,
  DriverDocumentType.VEHICLE_INSURANCE,
  DriverDocumentType.VEHICLE_FITNESS,
  DriverDocumentType.VEHICLE_PERMIT,
  DriverDocumentType.POLLUTION_CERTIFICATE,
] as const;

/* ------------------------------------------------------------------ *
 * Ops (migration 008)
 * ------------------------------------------------------------------ */

export const IncidentType = {
  ACCIDENT: 'ACCIDENT',
  HARASSMENT: 'HARASSMENT',
  FRAUD: 'FRAUD',
  PROPERTY_DAMAGE: 'PROPERTY_DAMAGE',
  ROUTE_DEVIATION: 'ROUTE_DEVIATION',
  OVERCHARGE: 'OVERCHARGE',
  VEHICLE_MISMATCH: 'VEHICLE_MISMATCH',
  RUDE_BEHAVIOUR: 'RUDE_BEHAVIOUR',
  LOST_ITEM: 'LOST_ITEM',
  OTHER: 'OTHER',
} as const;
export type IncidentTypeValue =
  (typeof IncidentType)[keyof typeof IncidentType];

export const IncidentStatus = {
  OPEN: 'OPEN',
  TRIAGED: 'TRIAGED',
  INVESTIGATING: 'INVESTIGATING',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;
export type IncidentStatusValue =
  (typeof IncidentStatus)[keyof typeof IncidentStatus];

export const IncidentSeverity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type IncidentSeverityValue =
  (typeof IncidentSeverity)[keyof typeof IncidentSeverity];

/**
 * Incident types that are auto-escalated to CRITICAL on intake and pinged to
 * the safety on-call rota regardless of who reported them.
 */
export const CRITICAL_INCIDENT_TYPES: readonly IncidentTypeValue[] = [
  IncidentType.ACCIDENT,
  IncidentType.HARASSMENT,
] as const;

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  BANNED: 'BANNED',
  DELETED: 'DELETED',
} as const;
export type AccountStatusValue =
  (typeof AccountStatus)[keyof typeof AccountStatus];

/* ------------------------------------------------------------------ *
 * Engagement (migration 008)
 * ------------------------------------------------------------------ */

export const DevicePlatform = {
  ANDROID: 'ANDROID',
  IOS: 'IOS',
  WEB: 'WEB',
} as const;
export type DevicePlatformValue =
  (typeof DevicePlatform)[keyof typeof DevicePlatform];

export const NotificationType = {
  RIDE_UPDATE: 'RIDE_UPDATE',
  PAYMENT: 'PAYMENT',
  PROMO: 'PROMO',
  SAFETY: 'SAFETY',
  INCENTIVE: 'INCENTIVE',
  DOCUMENT: 'DOCUMENT',
  SETTLEMENT: 'SETTLEMENT',
  SYSTEM: 'SYSTEM',
} as const;
export type NotificationTypeValue =
  (typeof NotificationType)[keyof typeof NotificationType];

/* ------------------------------------------------------------------ *
 * Growth + geo (migration 009)
 * ------------------------------------------------------------------ */

export const AreaType = {
  CITY_BOUNDARY: 'CITY_BOUNDARY',
  AIRPORT: 'AIRPORT',
  RAILWAY_STATION: 'RAILWAY_STATION',
  RESTRICTED_PICKUP: 'RESTRICTED_PICKUP',
  RESTRICTED_DROPOFF: 'RESTRICTED_DROPOFF',
  SURGE_ZONE: 'SURGE_ZONE',
  DRIVER_QUEUE: 'DRIVER_QUEUE',
  TOLL_ZONE: 'TOLL_ZONE',
} as const;
export type AreaTypeValue = (typeof AreaType)[keyof typeof AreaType];

export const IncentiveStatus = {
  ACTIVE: 'ACTIVE',
  ACHIEVED: 'ACHIEVED',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type IncentiveStatusValue =
  (typeof IncentiveStatus)[keyof typeof IncentiveStatus];

export const ReferralStatus = {
  PENDING: 'PENDING',
  QUALIFIED: 'QUALIFIED',
  REWARDED: 'REWARDED',
  REJECTED: 'REJECTED',
} as const;
export type ReferralStatusValue =
  (typeof ReferralStatus)[keyof typeof ReferralStatus];

export const RideStopStatus = {
  PENDING: 'PENDING',
  ARRIVED: 'ARRIVED',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
} as const;
export type RideStopStatusValue =
  (typeof RideStopStatus)[keyof typeof RideStopStatus];
