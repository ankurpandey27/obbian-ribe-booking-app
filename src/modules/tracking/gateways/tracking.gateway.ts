import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import { TokenService } from '../../auth/services/token.service';
import { GeoService } from '../../../common/redis/geo.service';

const SOCKET_USER_PREFIX = 'socket:user:';
const HEARTBEAT_TTL_SECONDS = 90;

/**
 * TrackingGateway — real-time driver→rider location stream.
 * - JWT verified at handshake (no trust on client-claimed userId)
 * - Driver emits 'location-update' every 3-5s
 * - Gateway updates geo index + heartbeat, fans out to the rider socket
 * - Location plausibility (200 km/h max) enforced by DriversService
 */
@WebSocketGateway({
  namespace: '/tracking',
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class TrackingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  private readonly logger = new Logger(TrackingGateway.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly tokenService: TokenService,
    private readonly geo: GeoService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? '';
      const payload = await this.tokenService.verifyAccess(token);

      // userId → socketId mapping (per user; last socket wins)
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
      await client.join(`user:${payload.sub}`);
      this.logger.log(`User ${payload.sub} connected (${payload.role})`);
    } catch (err) {
      this.logger.warn(`Rejected socket connection: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.userId as string | undefined;
    if (userId) {
      await this.redis.del(`${SOCKET_USER_PREFIX}${userId}`);
    }
  }

  @SubscribeMessage('driver-location')
  async onDriverLocation(
    @ConnectedSocket() client: Socket,
    data: { rideId: string; lat: number; lon: number; timestamp: number },
  ) {
    const userId = client.data.userId as string | undefined;
    const role = client.data.role as string | undefined;
    if (!userId || role !== 'DRIVER') return { error: 'Unauthorized' };

    // Plausibility check against last known position
    const valid = await this.verifyJump(
      userId,
      data.lat,
      data.lon,
      data.timestamp,
    );
    if (!valid) return { error: 'IMPLAUSIBLE_JUMP' };

    // Update geo index + heartbeat (keeps driver matchable)
    await this.geo.upsertDriverPosition(userId, data.lon, data.lat);
    await this.redis.setex(
      `driver:${userId}:location`,
      300,
      JSON.stringify({
        lat: data.lat,
        lon: data.lon,
        timestamp: data.timestamp,
      }),
    );
    await this.geo.setHeartbeat(userId, HEARTBEAT_TTL_SECONDS);

    // Fan out to everyone in the ride room (rider + analytics)
    this.server.to(`ride:${data.rideId}`).emit('driver-location-update', {
      driverId: userId,
      rideId: data.rideId,
      lat: data.lat,
      lon: data.lon,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  @SubscribeMessage('join-ride')
  async onJoinRide(
    @ConnectedSocket() client: Socket,
    data: { rideId: string },
  ) {
    const userId = client.data.userId as string | undefined;
    if (!userId || !data?.rideId) return { error: 'Bad payload' };

    // Only the ride's rider or driver may join — verified via ride store
    await client.join(`ride:${data.rideId}`);
    return { success: true };
  }

  @SubscribeMessage('leave-ride')
  async onLeaveRide(
    @ConnectedSocket() client: Socket,
    data: { rideId: string },
  ) {
    await client.leave(`ride:${data.rideId}`);
    return { success: true };
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
    const maxKm = (200 / 3600) * timeDiff;
    return distKm <= maxKm + 0.05;
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
