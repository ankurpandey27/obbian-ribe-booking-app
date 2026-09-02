import { Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { TokenService } from '../../auth/token.service';
import { GeoService } from '../../../common/redis/geo.service';
import { RidesService } from '../../rides/rides.service';
import { TrackingService } from '../tracking.service';
import { MetricsService } from '../../../common/observability/metrics.service';
import { RedisCircuitBreaker } from '../../../common/redis/redis-circuit-breaker.service';

const SOCKET_USER_PREFIX = 'socket:user:';
const HEARTBEAT_TTL_SECONDS = 90;

/** Per-driver location rate limit window. */
const LOCATION_RATE_WINDOW_SECONDS = 60;

/**
 * TrackingGateway — real-time driver→rider location stream.
 *
 * - JWT verified at handshake; nothing trusts a client-claimed userId.
 * - Driver emits `driver-location` every 3–5s.
 * - Gateway refreshes the geo index + heartbeat, then fans out to the ride room.
 * - Plausibility (max ground speed) and a per-driver rate limit are enforced
 *   before anything is written.
 *
 * CORS is deliberately NOT set here. It is configured centrally in
 * RedisIoAdapter from `REALTIME_CORS_ORIGINS`; this decorator previously carried
 * `cors: { origin: '*' }`, which let any website open an authenticated socket.
 *
 * Cross-pod correctness comes from the Redis adapter installed in main.ts —
 * without it `server.to(room).emit()` only reaches sockets on the emitting pod.
 */
@WebSocketGateway({
  namespace: '/tracking',
  transports: ['websocket', 'polling'],
})
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  private readonly logger = new Logger(TrackingGateway.name);
  private readonly locationRateLimitPerMinute: number;
  private readonly maxSpeedKmph: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly tokenService: TokenService,
    private readonly geo: GeoService,
    private readonly rides: RidesService,
    private readonly tracking: TrackingService,
    config: ConfigService,
    private readonly breaker: RedisCircuitBreaker,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.locationRateLimitPerMinute = config.get<number>(
      'tracking.locationRateLimitPerMinute',
      40,
    );
    this.maxSpeedKmph = config.get<number>('tracking.maxSpeedKmph', 200);
  }

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? '';
      const payload = await this.tokenService.verifyAccess(token);

      // userId → socketId mapping (per user; last socket wins).
      const prev = await this.redis.get(`${SOCKET_USER_PREFIX}${payload.sub}`);
      if (prev && prev !== client.id) {
        this.server.sockets.sockets.get(prev)?.disconnect(true);
      }
      await this.redis.set(
        `${SOCKET_USER_PREFIX}${payload.sub}`,
        client.id,
        'EX',
        86400,
      );

      client.data.userId = payload.sub;
      client.data.role = payload.role;
      this.metrics?.incSocketConnections('/tracking');
      await client.join(`user:${payload.sub}`);
      this.logger.log(`User ${payload.sub} connected (${payload.role})`);
    } catch (err) {
      this.logger.warn(`Rejected socket connection: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId) this.metrics?.decSocketConnections('/tracking');
    if (userId) {
      // Only clear the mapping if it still points at THIS socket. A reconnect
      // that already claimed the slot must not have its mapping deleted by the
      // old socket's late disconnect event.
      const current = await this.redis.get(`${SOCKET_USER_PREFIX}${userId}`);
      if (current === client.id) {
        await this.redis.del(`${SOCKET_USER_PREFIX}${userId}`);
      }
    }
  }

  @SubscribeMessage('driver-location')
  async onDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: { rideId: string; lat: number; lon: number; timestamp: number },
  ) {
    const userId = client.data.userId as string | undefined;
    const role = client.data.role as string | undefined;
    if (!userId || role !== 'DRIVER') return { error: 'Unauthorized' };
    if (
      !data ||
      !Number.isFinite(data.lat) ||
      !Number.isFinite(data.lon) ||
      Math.abs(data.lat) > 90 ||
      Math.abs(data.lon) > 180
    ) {
      return { error: 'INVALID_COORDINATES' };
    }

    // Rate limit BEFORE any Redis write. A buggy or hostile client shipping
    // 100 fixes/second would otherwise hammer the geo index for every one.
    if (!(await this.withinRateLimit(userId))) {
      return { error: 'RATE_LIMITED' };
    }

    const timestamp = Number.isFinite(data.timestamp)
      ? data.timestamp
      : Date.now();

    if (data.rideId) {
      const ride = await this.rides.getRide(data.rideId).catch(() => null);
      if (!ride || ride.driverId !== userId) return { error: 'Forbidden' };
    }

    // Plausibility check against the last known position.
    if (!(await this.verifyJump(userId, data.lat, data.lon, timestamp))) {
      return { error: 'IMPLAUSIBLE_JUMP' };
    }

    await this.geo.upsertDriverPosition(userId, data.lon, data.lat);
    await this.geo.cacheDriverPosition(userId, data.lat, data.lon, timestamp);
    await this.geo.setHeartbeat(userId, HEARTBEAT_TTL_SECONDS);

    // Fan out to the ride room. Reaches other pods via the Redis adapter.
    if (data.rideId) {
      this.server.to(`ride:${data.rideId}`).emit('driver-location-update', {
        driverId: userId,
        rideId: data.rideId,
        lat: data.lat,
        lon: data.lon,
        timestamp,
      });
      void this.tracking
        .refreshEtaForMovement(data.rideId)
        .then((eta) => {
          if (eta) {
            this.server.to(`ride:${data.rideId}`).emit('eta-update', {
              rideId: data.rideId,
              ...eta,
              updatedAt: Date.now(),
            });
          }
        })
        .catch((err: unknown) =>
          this.logger.warn(`ETA refresh failed: ${(err as Error).message}`),
        );
    }

    return { success: true };
  }

  /**
   * Join a ride's live-tracking room.
   *
   * AUTHORIZATION: membership is verified against the ride itself. This
   * previously only carried a comment claiming the check existed — any
   * authenticated user could join `ride:<uuid>` and watch a stranger's live
   * location and route. Ride rooms are now participant-only, matching
   * RideParticipantGuard on the REST side.
   */
  @SubscribeMessage('join-ride')
  async onJoinRide(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { rideId: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !data?.rideId) return { error: 'Bad payload' };
    if (!this.looksLikeUuid(data.rideId)) return { error: 'Bad payload' };

    let isParticipant: boolean;
    try {
      const ride = await this.rides.getRide(data.rideId);
      isParticipant = ride.riderId === userId || ride.driverId === userId;
    } catch {
      // Unknown ride — report the same generic refusal as a non-participant so
      // the socket cannot be used to probe which ride ids exist.
      return { error: 'Forbidden' };
    }

    if (!isParticipant) {
      this.logger.warn(
        `user ${userId} denied join for ride ${data.rideId} (not a participant)`,
      );
      return { error: 'Forbidden' };
    }

    await client.join(`ride:${data.rideId}`);
    return { success: true };
  }

  @SubscribeMessage('leave-ride')
  async onLeaveRide(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { rideId: string },
  ) {
    if (!data?.rideId) return { error: 'Bad payload' };
    await client.leave(`ride:${data.rideId}`);
    return { success: true };
  }

  /**
   * Sliding-window rate limit per driver.
   *
   * INCR + EXPIRE on first hit: the key expires on its own, so there is no
   * cleanup job and a driver who goes offline leaves nothing behind.
   * Fails OPEN — if Redis is unavailable we accept the ping rather than
   * blackholing live tracking for every driver at once.
   */
  private async withinRateLimit(driverId: string): Promise<boolean> {
    const key = `ratelimit:driverloc:${driverId}`;
    try {
      const count = await this.breaker.execute(
        'location_rate_limit',
        'open',
        async () => {
          const hits = await this.redis.incr(key);
          if (hits === 1) {
            await this.redis.expire(key, LOCATION_RATE_WINDOW_SECONDS);
          }
          return hits;
        },
      );
      if (count === undefined) return true;
      if (count > this.locationRateLimitPerMinute) {
        // Logged once at the boundary, not on every subsequent ping.
        if (count === this.locationRateLimitPerMinute + 1) {
          this.logger.warn(
            `driver ${driverId} exceeded ${this.locationRateLimitPerMinute} ` +
              'location updates/min — throttling',
          );
        }
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(
        `location rate limit check failed, allowing: ${(err as Error).message}`,
      );
      return true;
    }
  }

  private async verifyJump(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
  ): Promise<boolean> {
    const prev = await this.geo.getDriverPosition(driverId);
    if (!prev) return true;

    const timeDiff = (timestamp - prev.timestamp) / 1000;
    if (timeDiff <= 0) return false;

    const distKm = this.haversine(prev.lat, prev.lon, lat, lon);
    const maxKm = (this.maxSpeedKmph / 3600) * timeDiff;
    // Small tolerance absorbs GPS jitter on a stationary vehicle.
    return distKm <= maxKm + 0.05;
  }

  private looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  /**
   * Server-side emit of the pickup boarding code to the rider's socket room.
   * Called by RidesService after driverArrive generates the code. Reaches riders
   * on other pods via the Redis adapter (cross-pod correctness).
   */
  notifyBoardingCode(riderId: string, rideId: string, code: string): void {
    this.server.to(`user:${riderId}`).emit('pickup-code', {
      rideId,
      code,
      expiresInSec: 600,
    });
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
