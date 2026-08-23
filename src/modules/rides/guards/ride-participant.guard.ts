import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RidesService } from '../services/rides.service';
import { IS_PUBLIC_KEY } from '../../../common/auth/decorators';

/**
 * RideParticipantGuard — authorizes ride-scoped routes by verifying the
 * caller is a participant of the ride (rider or assigned driver).
 *
 * Attach with @UseGuards(RideParticipantGuard) on any route carrying
 * `:rideId`. The loaded ride is cached on request.ride so downstream
 * handlers avoid a duplicate fetch.
 *
 * Microservice note: this guard encapsulates the trip-ownership rule;
 * when trip-service is extracted, the guard ships with it unchanged.
 */
@Injectable()
export class RideParticipantGuard implements CanActivate {
  constructor(
    private readonly rides: RidesService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const rideId = String(request.params?.rideId ?? '');
    if (!user?.sub || !rideId) return false;

    // Webhook/system paths never carry :rideId; they bypass via @Public.
    if (!this.looksLikeUuid(rideId)) {
      throw new ForbiddenException('Not a participant of this ride');
    }

    const ride = await this.rides.getRide(rideId);
    if (ride.riderId !== user.sub && ride.driverId !== user.sub) {
      throw new ForbiddenException('Not a participant of this ride');
    }
    request.ride = ride;
    return true;
  }

  /** Cheap pre-check so malformed ids fail closed without a DB hit. */
  private looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
