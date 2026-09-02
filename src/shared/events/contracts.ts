import { DomainEvent } from './topics';

/* ------------------------------------------------------------------ */
/* RIDE EVENTS (topic: ride-events)                                    */
/* Partition key: rideId. Emitted by rides module on every transition. */
/* ------------------------------------------------------------------ */

export const RideEventType = {
  RIDE_REQUESTED: 'RIDE_REQUESTED',
  RIDE_ACCEPTED: 'RIDE_ACCEPTED',
  RIDE_ARRIVED: 'RIDE_ARRIVED',
  RIDE_STARTED: 'RIDE_STARTED',
  RIDE_COMPLETED: 'RIDE_COMPLETED',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
} as const;

export type RideEventTypeValue =
  (typeof RideEventType)[keyof typeof RideEventType];

export interface RideEventPayload {
  rideId: string;
  riderId: string;
  driverId?: string;
  status: string;
  rideType: string;
  totalFare?: number;
  cancellationReason?: string;
  cancellationFee?: number;
  occurredAt: string;
}

export type RideEvent = DomainEvent<RideEventPayload> & {
  type: RideEventTypeValue;
};

/* ------------------------------------------------------------------- */
/* DRIVER OFFERS (topic: driver-offers)                                 */
/* Partition key: driverId. Produced by matching, consumed by tracking  */
/* (push to driver device via FCM/WS).                                  */
/* ------------------------------------------------------------------- */

export const OfferEventType = {
  OFFER_SENT: 'OFFER_SENT',
  OFFER_WITHDRAWN: 'OFFER_WITHDRAWN',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
} as const;

export interface OfferEventPayload {
  offerId: string;
  rideId: string;
  driverId: string;
  pickupLat: number;
  pickupLon: number;
  estimatedFare: number;
  estimatedEarnings: number;
  expiresAt: string;
}

/* ---------------------------------------------------------------------- */
/* DRIVER RESPONSES (topic: driver-responses)                              */
/* Partition key: rideId. Produced by tracking (driver app actions),       */
/* consumed by matching (claim resolution).                                */
/* ---------------------------------------------------------------------- */

export const DriverResponseType = {
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
} as const;

export interface DriverResponsePayload {
  offerId: string;
  rideId: string;
  driverId: string;
  response: (typeof DriverResponseType)[keyof typeof DriverResponseType];
  reason?: string;
  respondedAt: string;
}

/* ---------------------------------------------------------------- */
/* LOCATION EVENTS (topic: location-events)                          */
/* Partition key: driverId. High volume — used by analytics only.    */
/* Live positions live in Redis; Kafka is the durable audit trail.   */
/* ---------------------------------------------------------------- */

export interface LocationEventPayload {
  driverId: string;
  rideId?: string;
  lat: number;
  lon: number;
  accuracy?: number;
  eventTime: string;
}

/* ----------------------------------------------------------------- */
/* PAYMENT EVENTS (topic: payment-events)                             */
/* Partition key: paymentId. Produced by payments module.             */
/* ----------------------------------------------------------------- */

export const PaymentEventType = {
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  DRIVER_SETTLED: 'DRIVER_SETTLED',
} as const;

export interface PaymentEventPayload {
  paymentId: string;
  rideId: string;
  amount: number;
  currency: string;
  method: string;
  gatewayTransactionId?: string;
  failureReason?: string;
}

/* ----------------------------------------------------------------- */
/* LEDGER EVENTS (topic: ledger-events)                               */
/* Partition key: driverId — every entry for one wallet lands in the   */
/* same partition, so a consumer replaying a driver's balance sees     */
/* entries in the order they were written.                             */
/* All amounts are INTEGER PAISE (never rupees, never float).          */
/* ----------------------------------------------------------------- */

export const LedgerEventType = {
  LEDGER_ENTRY_WRITTEN: 'LEDGER_ENTRY_WRITTEN',
  SETTLEMENT_LEDGERED: 'SETTLEMENT_LEDGERED',
  SETTLEMENT_PAID: 'SETTLEMENT_PAID',
  SETTLEMENT_FAILED: 'SETTLEMENT_FAILED',
  /** Cached balance disagreed with the ledger replay — always a P1. */
  BALANCE_DRIFT_DETECTED: 'BALANCE_DRIFT_DETECTED',
} as const;

export type LedgerEventTypeValue =
  (typeof LedgerEventType)[keyof typeof LedgerEventType];

export interface LedgerEntryEventPayload {
  ledgerEntryId: string;
  driverId: string;
  entryType: string;
  amountPaise: number;
  balanceAfterPaise: number;
  referenceType?: string;
  referenceId?: string;
  occurredAt: string;
}

export interface SettlementEventPayload {
  settlementId: string;
  driverId: string;
  periodStart: string;
  periodEnd: string;
  rideCount: number;
  grossPaise: number;
  commissionPaise: number;
  netPayoutPaise: number;
  status: string;
  payoutReference?: string;
  failureReason?: string;
  occurredAt: string;
}

export interface BalanceDriftEventPayload {
  driverId: string;
  /** Value stored on drivers.walletBalancePaise. */
  cachedBalancePaise: number;
  /** SUM(wallet_ledger.amountPaise) — the authoritative figure. */
  ledgerBalancePaise: number;
  driftPaise: number;
  detectedAt: string;
}

/* ----------------------------------------------------------------- */
/* COMPLIANCE EVENTS (topic: compliance-events)                       */
/* Partition key: driverId. Consumed by matching (dispatch            */
/* eligibility) and notifications (renewal reminders).                */
/* ----------------------------------------------------------------- */

export const ComplianceEventType = {
  DOCUMENT_SUBMITTED: 'DOCUMENT_SUBMITTED',
  DOCUMENT_VERIFIED: 'DOCUMENT_VERIFIED',
  DOCUMENT_REJECTED: 'DOCUMENT_REJECTED',
  DOCUMENT_EXPIRED: 'DOCUMENT_EXPIRED',
  DOCUMENT_EXPIRING_SOON: 'DOCUMENT_EXPIRING_SOON',
  /** Driver became dispatch-eligible: every required document is valid. */
  DRIVER_COMPLIANCE_GRANTED: 'DRIVER_COMPLIANCE_GRANTED',
  /** Driver lost eligibility — matching must stop offering them rides. */
  DRIVER_COMPLIANCE_REVOKED: 'DRIVER_COMPLIANCE_REVOKED',
} as const;

export type ComplianceEventTypeValue =
  (typeof ComplianceEventType)[keyof typeof ComplianceEventType];

export interface ComplianceEventPayload {
  driverId: string;
  documentId?: string;
  documentType?: string;
  vehicleId?: string;
  status?: string;
  expiresAt?: string;
  /** Populated on GRANTED/REVOKED so consumers need no second query. */
  isComplianceVerified?: boolean;
  /** Which required slots are missing/invalid on REVOKED. */
  missingDocuments?: string[];
  reason?: string;
  occurredAt: string;
}
