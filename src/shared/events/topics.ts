/**
 * Kafka topic registry — the single source of truth for event topics.
 * When any module is extracted into a microservice, these names and
 * payload contracts ship with it unchanged.
 */
export const TOPICS = {
  RIDE_EVENTS: 'ride-events',
  DRIVER_OFFERS: 'driver-offers',
  DRIVER_RESPONSES: 'driver-responses',
  LOCATION_EVENTS: 'location-events',
  PAYMENT_EVENTS: 'payment-events',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/** Event bus wire format. Every event carries correlation for replay/debug. */
export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  topic: TopicName;
  timestamp: string; // ISO 8601
  payload: T;
}
