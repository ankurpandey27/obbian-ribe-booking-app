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
