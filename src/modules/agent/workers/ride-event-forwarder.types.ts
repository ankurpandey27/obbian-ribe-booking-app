/** Wire envelope the Roju agent's /api/v1/agent/events endpoint expects. */
export type AgentEventName =
  | 'ride.driver_assigned'
  | 'ride.no_drivers_found'
  | 'ride.driver_cancelled'
  | 'ride.driver_arrived'
  | 'ride.driver_cannot_locate'
  | 'ride.started'
  | 'ride.completed'
  | 'ride.payment_failed';

export interface AgentEventPayload {
  eventId: string;
  event: AgentEventName;
  userId: string;
  rideId: string;
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface OutboxRow {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface DriverEnrichment {
  driverName?: string;
  vehicle?: string;
  plate?: string;
}

/**
 * Maps Obbian ride outbox events to agent event names. Rider-initiated
 * cancels and REQUESTED are intentionally not forwarded (the agent already
 * knows; NO_DRIVERS arrives via its own lifecycle path).
 */
export function mapRideEvent(
  row: OutboxRow,
  enrichment?: DriverEnrichment,
): AgentEventPayload | null {
  const p = row.payload ?? {};
  const base = {
    eventId: row.id,
    userId: String(p['riderId'] ?? ''),
    rideId: String(p['rideId'] ?? row.aggregateId),
    occurredAt:
      typeof p['occurredAt'] === 'string'
        ? p['occurredAt']
        : row.createdAt.toISOString(),
  };
  switch (row.eventType) {
    case 'RIDE_ACCEPTED':
      return {
        ...base,
        event: 'ride.driver_assigned',
        data: { ...(enrichment ?? {}) },
      };
    case 'RIDE_ARRIVED':
      return { ...base, event: 'ride.driver_arrived', data: {} };
    case 'RIDE_IN_PROGRESS':
      return { ...base, event: 'ride.started', data: {} };
    case 'RIDE_COMPLETED':
      return {
        ...base,
        event: 'ride.completed',
        data: { totalFare: p['totalFare'] ?? null },
      };
    case 'RIDE_CANCELLED': {
      if (p['cancellationReason'] === 'DRIVER_CANCELLED') {
        return { ...base, event: 'ride.driver_cancelled', data: {} };
      }
      return null;
    }
    default:
      return null;
  }
}
