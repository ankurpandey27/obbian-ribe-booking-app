import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { PricingService } from '../pricing/pricing.service';
import { RidesService } from '../rides/rides.service';
import { TrackingService } from '../tracking/tracking.service';
import type { JwtPayload } from '../auth/token.service';
import type {
  AgentExecuteRequestDto,
  AgentQuoteRequestDto,
  AgentQuoteResponseDto,
  AgentExecuteResponseDto,
} from './dto/agent.dto';

interface StoredAgentQuote {
  userId: string;
  farePaise: number;
  surgeMultiplier: number;
  rideType: string;
  city: string;
  expiresAt: string;
}

const QUOTE_TTL_SEC = 600;
const IDEMPOTENCY_TTL_SEC = 600;

/**
 * Agent surface for the Roju voice/chat agent (ADR-00X). Thin orchestration
 * over existing domain services — the agent NEVER bypasses fraud guards,
 * price locks, or the ride state machine. Quote ids are short-lived server
 * state so execute can re-validate the exact fare the rider confirmed.
 */
@Injectable()
export class AgentRidesService {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly pricing: PricingService,
    private readonly rides: RidesService,
    private readonly tracking: TrackingService,
  ) {}

  async quote(
    user: JwtPayload,
    dto: AgentQuoteRequestDto,
  ): Promise<AgentQuoteResponseDto> {
    const city = dto.city ?? 'Hyderabad';
    const requestedType = dto.rideType ?? 'AUTO';
    const result = await this.pricing.getQuote(
      dto.pickupLat,
      dto.pickupLon,
      dto.dropoffLat,
      dto.dropoffLon,
      city,
      [requestedType] as never,
    );
    const option =
      result.options.find((o) => o.rideType === requestedType) ??
      result.options[0];
    if (!option) throw new NotFoundException('No fare config for ride type');

    const surgeMultiplier = Number(
      result.surgeMultiplier ?? option.surgeMultiplier ?? 1,
    );
    const farePaise = Math.round(option.fare * 100);
    const quoteId = `aq_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + QUOTE_TTL_SEC * 1000).toISOString();

    const stored: StoredAgentQuote = {
      userId: user.sub,
      farePaise,
      surgeMultiplier,
      rideType: option.rideType,
      city,
      expiresAt,
    };
    await this.redis.set(
      `agent:quote:${quoteId}`,
      JSON.stringify(stored),
      'EX',
      QUOTE_TTL_SEC,
    );

    return {
      quoteId,
      farePaise,
      surgeMultiplier,
      surgeReason: surgeMultiplier > 1.0 ? 'high_demand' : null,
      etaMinutes: option.etaMinutes,
      distanceKm: Number(result.distanceKm.toFixed(2)),
      expiresAt,
    };
  }

  async execute(
    user: JwtPayload,
    dto: AgentExecuteRequestDto,
  ): Promise<AgentExecuteResponseDto> {
    const idemKey = `agent:idem:${user.sub}:${dto.idempotencyKey}`;
    const cached = await this.redis.get(idemKey);
    if (cached) return JSON.parse(cached) as AgentExecuteResponseDto;

    let response: AgentExecuteResponseDto;
    try {
      switch (dto.action) {
        case 'create_item':
          response = await this.executeCreate(user, dto);
          break;
        case 'cancel_item':
          response = await this.executeCancel(user, dto);
          break;
        case 'check_status':
          response = await this.executeStatus(user);
          break;
        case 'modify_item':
          // Obbian has no mid-ride modification yet; the agent renders a
          // dedicated template. Additive support lands with trip-edit domain.
          response = {
            success: false,
            templateKey: 'MODIFY_UNSUPPORTED',
            error: { code: 'NOT_SUPPORTED', message: 'modify_item pending' },
          };
          break;
        default:
          throw new BadRequestException(`Unknown action: ${dto.action}`);
      }
    } catch (err) {
      response = this.toErrorResult(err);
    }

    await this.redis.set(
      idemKey,
      JSON.stringify(response),
      'EX',
      IDEMPOTENCY_TTL_SEC,
    );
    return response;
  }

  private async executeCreate(
    user: JwtPayload,
    dto: AgentExecuteRequestDto,
  ): Promise<AgentExecuteResponseDto> {
    if (!dto.quoteId) {
      throw new BadRequestException('quoteId is required for create_item');
    }
    const raw = await this.redis.get(`agent:quote:${dto.quoteId}`);
    if (!raw) throw new BadRequestException('QUOTE_EXPIRED');
    const stored = JSON.parse(raw) as StoredAgentQuote;
    if (stored.userId !== user.sub) {
      throw new BadRequestException('QUOTE_EXPIRED'); // do not leak existence
    }
    const clientFarePaise = Number(dto.params['farePaise']);
    if (
      Number.isFinite(clientFarePaise) &&
      clientFarePaise !== stored.farePaise
    ) {
      throw new BadRequestException('FARE_MISMATCH');
    }

    const { ride } = await this.rides.requestRide(user.sub, {
      pickupLat: requireNumber(dto.params, 'pickupLat'),
      pickupLon: requireNumber(dto.params, 'pickupLon'),
      dropoffLat: requireNumber(dto.params, 'dropoffLat'),
      dropoffLon: requireNumber(dto.params, 'dropoffLon'),
      rideType: stored.rideType as never,
      city: stored.city,
    });

    return {
      success: true,
      itemId: ride.id,
      templateKey: 'BOOKING_CONFIRMED',
      data: {
        status: ride.status,
        estimatedFarePaise: Math.round(Number(ride.estimatedFare) * 100),
      },
    };
  }

  private async executeCancel(
    user: JwtPayload,
    dto: AgentExecuteRequestDto,
  ): Promise<AgentExecuteResponseDto> {
    const rideId = await this.resolveOwnedRideId(
      user.sub,
      dto.params['itemId'],
    );
    if (!rideId) {
      return {
        success: false,
        templateKey: 'NO_ACTIVE_RIDE',
        error: { code: 'NO_ACTIVE_RIDE', message: 'no cancellable ride' },
      };
    }
    const { refundAmount } = await this.rides.cancel(
      rideId,
      'USER_CANCELLED',
      'RIDER',
    );
    return {
      success: true,
      itemId: rideId,
      templateKey: 'CANCELLED_OK',
      data: { refundAmount },
    };
  }

  private async executeStatus(
    user: JwtPayload,
  ): Promise<AgentExecuteResponseDto> {
    const rides = await this.rides.getActiveRidesForRider(user.sub);
    const active = rides[rides.length - 1];
    if (!active) {
      return {
        success: true,
        templateKey: 'STATUS_OK',
        data: { status: 'none' },
      };
    }
    const tracking = await this.tracking
      .getTracking(active.id)
      .catch(() => null);
    return {
      success: true,
      itemId: active.id,
      templateKey: 'STATUS_OK',
      data: {
        status: tracking?.status ?? active.status,
        etaMinutes: tracking?.eta?.etaMinutes ?? null,
        driverLat: tracking?.driver?.lat ?? null,
        driverLon: tracking?.driver?.lon ?? null,
      },
    };
  }

  /** Ownership: only rides in the caller's own active set are actionable. */
  private async resolveOwnedRideId(
    riderId: string,
    itemId: unknown,
  ): Promise<string | null> {
    const actives = await this.rides.getActiveRidesForRider(riderId);
    if (itemId && typeof itemId === 'string') {
      return actives.some((r) => r.id === itemId) ? itemId : null;
    }
    return actives[actives.length - 1]?.id ?? null;
  }

  private toErrorResult(err: unknown): AgentExecuteResponseDto {
    if (err instanceof BadRequestException) {
      const body = err.getResponse() as string | { message?: string };
      const message =
        typeof body === 'string' ? body : (body['message'] ?? err.message);
      const code = String(message).split(' ')[0];
      if (code === 'QUOTE_EXPIRED') {
        return {
          success: false,
          templateKey: 'QUOTE_EXPIRED',
          error: { code, message: String(message) },
        };
      }
      if (code === 'FARE_MISMATCH') {
        return {
          success: false,
          templateKey: 'QUOTE_EXPIRED',
          error: { code, message: String(message) },
        };
      }
      if (String(message).includes('No drivers')) {
        return {
          success: false,
          templateKey: 'NO_DRIVERS',
          error: { code: 'NO_DRIVERS', message: String(message) },
        };
      }
    }
    return {
      success: false,
      templateKey: 'GENERIC_FAILURE',
      error: { code: 'EXECUTE_FAILED', message: String(err).slice(0, 200) },
    };
  }
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const v = Number(params[key]);
  if (!Number.isFinite(v)) {
    throw new BadRequestException(`${key} must be a resolved coordinate`);
  }
  return v;
}
