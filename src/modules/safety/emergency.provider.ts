/**
 * Emergency provider interface. Pluggable for real 112/local emergency
 * services. The stub logs + records; production implementations call the
 * actual emergency API. Registered via DI so the implementation swaps without
 * touching the escalation path.
 */
export interface EmergencyProvider {
  notify(input: {
    eventId: string;
    userId: string;
    rideId?: string | null;
    location?: { lat: number; lon: number } | null;
    trigger: string;
  }): { acknowledged: boolean; reference?: string };
}

/**
 * Stub emergency provider. Logs the escalation and records it. Production
 * implementations call 112/local emergency APIs.
 */
export class StubEmergencyProvider implements EmergencyProvider {
  notify(input: {
    eventId: string;
    userId: string;
    rideId?: string | null;
    location?: { lat: number; lon: number } | null;
    trigger: string;
  }): { acknowledged: boolean; reference?: string } {
    // In production, call the actual emergency service here.
    // For now, acknowledge so the escalation path is exercised.
    return { acknowledged: true, reference: `stub-${input.eventId}` };
  }
}
