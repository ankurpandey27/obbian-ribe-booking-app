import { BadRequestException } from '@nestjs/common';
import { RideStatusValue } from '../../../shared/types/common';

/**
 * RideStateMachine — single source of truth for legal transitions.
 * Every status change MUST go through this. Invalid transitions are
 * rejected with a clear message (e.g., a stale client action).
 */
export class RideStateMachine {
  private static readonly TRANSITIONS: Record<
    RideStatusValue,
    RideStatusValue[]
  > = {
    REQUESTED: ['MATCHING', 'CANCELLED'],
    MATCHING: ['ACCEPTED', 'CANCELLED'],
    ACCEPTED: ['ARRIVED', 'CANCELLED'],
    ARRIVED: ['IN_PROGRESS', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };

  static assertTransition(from: RideStatusValue, to: RideStatusValue): void {
    if (from === to) return;
    const allowed = this.TRANSITIONS[from];
    if (!allowed?.includes(to)) {
      throw new BadRequestException(
        `Invalid ride transition: ${from} → ${to}. Allowed: ${allowed?.join(', ') ?? 'none'}`,
      );
    }
  }

  static canCancel(status: RideStatusValue): boolean {
    return this.TRANSITIONS[status].includes('CANCELLED');
  }

  static isTerminal(status: RideStatusValue): boolean {
    return status === 'COMPLETED' || status === 'CANCELLED';
  }
}
