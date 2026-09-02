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
  'REFUNDING',
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

/**
 * Ledger entry kinds (migration 005). The ledger is append-only and
 * double-entry-shaped: every row records balanceBefore/balanceAfter so a
 * driver's wallet is always reconstructable by replay. CREDIT kinds add,
 * DEBIT kinds subtract — the sign is derived from the kind, never passed in.
 */
export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'RIDE_EARNING', // credit: driver share of a completed ride
  'COMMISSION_DEBIT', // debit: platform commission on that ride
  'SETTLEMENT_DEBIT', // debit: balance paid out to the driver's bank/UPI
  'SETTLEMENT_REVERSAL', // credit: payout failed at the gateway, money returned
  'INCENTIVE_CREDIT', // credit: completed incentive/bonus target
  'PENALTY_DEBIT', // debit: cancellation fine, quality penalty
  'REFUND_ADJUSTMENT', // debit: rider refund clawed back from the driver share
  'MANUAL_ADJUSTMENT', // either: ops correction, always carries a reason
  'TIP_CREDIT', // credit: rider tip passed through in full
]);

/** Settlement run lifecycle (migration 005). */
export const settlementStatus = pgEnum('settlement_status', [
  'PENDING', // row created, ledger not yet written
  'LEDGERED', // ledger entries written, payout not attempted
  'PAID', // gateway confirmed the payout
  'FAILED', // gateway rejected; retried by the next run
  'CANCELLED', // ops voided the run before payout
]);

/** Driver document kinds required before a driver may go ONLINE. */
export const driverDocumentType = pgEnum('driver_document_type', [
  'DRIVING_LICENSE',
  'VEHICLE_REGISTRATION',
  'VEHICLE_INSURANCE',
  'VEHICLE_FITNESS',
  'VEHICLE_PERMIT',
  'POLLUTION_CERTIFICATE',
  'AADHAAR',
  'PAN',
  'PROFILE_PHOTO',
  'BANK_PROOF',
]);

/**
 * Document verification state machine. EXPIRED is terminal-until-replaced
 * and is set by the nightly expiry sweep, not by a human.
 */
export const documentStatus = pgEnum('document_status', [
  'PENDING',
  'IN_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
]);

/** Where a stop sits in a multi-stop ride (migration 007). */
export const rideStopStatus = pgEnum('ride_stop_status', [
  'PENDING',
  'ARRIVED',
  'COMPLETED',
  'SKIPPED',
]);

/** GST invoice lifecycle (migration 007). Issued invoices are immutable. */
export const invoiceStatus = pgEnum('invoice_status', [
  'DRAFT',
  'ISSUED',
  'CANCELLED',
]);

/** Safety/ops incident categories (migration 008). */
export const incidentType = pgEnum('incident_type', [
  'ACCIDENT',
  'HARASSMENT',
  'FRAUD',
  'PROPERTY_DAMAGE',
  'ROUTE_DEVIATION',
  'OVERCHARGE',
  'VEHICLE_MISMATCH',
  'RUDE_BEHAVIOUR',
  'LOST_ITEM',
  'OTHER',
]);

/** Incident triage lifecycle. Nothing auto-resolves. */
export const incidentStatus = pgEnum('incident_status', [
  'OPEN',
  'TRIAGED',
  'INVESTIGATING',
  'RESOLVED',
  'DISMISSED',
]);

export const incidentSeverity = pgEnum('incident_severity', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

/** Device platforms for push targeting (migration 008). */
export const devicePlatform = pgEnum('device_platform', [
  'ANDROID',
  'IOS',
  'WEB',
]);

/** In-app notification categories (migration 008). */
export const notificationType = pgEnum('notification_type', [
  'RIDE_UPDATE',
  'PAYMENT',
  'PROMO',
  'SAFETY',
  'INCENTIVE',
  'DOCUMENT',
  'SETTLEMENT',
  'SYSTEM',
]);

/** Account moderation state (migration 008). */
export const accountStatus = pgEnum('account_status', [
  'ACTIVE',
  'SUSPENDED',
  'BANNED',
  'DELETED',
]);

/** Geofenced area kinds (migration 009). */
export const areaType = pgEnum('area_type', [
  'CITY_BOUNDARY',
  'AIRPORT',
  'RAILWAY_STATION',
  'RESTRICTED_PICKUP',
  'RESTRICTED_DROPOFF',
  'SURGE_ZONE',
  'DRIVER_QUEUE',
  'TOLL_ZONE',
]);

/** Driver incentive lifecycle (migration 009). */
export const incentiveStatus = pgEnum('incentive_status', [
  'ACTIVE',
  'ACHIEVED',
  'PAID',
  'EXPIRED',
  'CANCELLED',
]);

/** Referral redemption lifecycle (migration 009). */
export const referralStatus = pgEnum('referral_status', [
  'PENDING',
  'QUALIFIED',
  'REWARDED',
  'REJECTED',
]);

export const UserRoleValue = userRole.enumValues;
export const RideTypeValue = rideType.enumValues;
export const RideStatusValue = rideStatus.enumValues;
export const DriverStatusValue = driverStatus.enumValues;
export const LedgerEntryTypeValue = ledgerEntryType.enumValues;
export const SettlementStatusValue = settlementStatus.enumValues;
export const DriverDocumentTypeValue = driverDocumentType.enumValues;
export const DocumentStatusValue = documentStatus.enumValues;
export const IncidentTypeValue = incidentType.enumValues;
export const IncidentStatusValue = incidentStatus.enumValues;
export const AreaTypeValue = areaType.enumValues;
