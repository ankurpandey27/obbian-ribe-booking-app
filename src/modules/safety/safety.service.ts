import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { safetyEvents } from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import type { RaiseSosDto } from './dto/safety.dto';
import type { EmergencyProvider } from './emergency.provider';

/**
 * SOS intake (ADR-00X): durable record + outbox event so ops/consumer
 * surfaces can page a human. Never auto-resolves; never rate-limited beyond
 * the global throttle.
 *
 * EmergencyProvider is optional — when configured, SOS also notifies the
 * external emergency service (112/local). The stub provider is used until a
 * real integration is wired.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly outbox: OutboxService,
    @InjectRedis() private readonly redis: Redis,
    @Optional() private readonly emergency?: EmergencyProvider,
  ) {}

  async raiseSos(
    userId: string,
    dto: RaiseSosDto,
  ): Promise<{ eventId: string; emergencyNotified: boolean }> {
    const eventId = randomUUID();

    await this.db.insert(safetyEvents).values({
      id: eventId,
      userId,
      rideId: dto.rideId ?? null,
      sessionId: dto.sessionId ?? null,
      trigger: dto.trigger,
      locationLat: dto.lat != null ? String(dto.lat) : null,
      locationLon: dto.lon != null ? String(dto.lon) : null,
      source: 'roju_agent',
      status: 'OPEN',
    });

    // The safety row is itself the durable record; the outbox event fans out
    // to consumers. write() accepts the root db handle (Exec includes it).
    await this.outbox.write(this.db, {
      topic: TOPICS.SAFETY_EVENTS,
      type: 'SAFETY_SOS_RAISED',
      aggregateType: 'safety_event',
      aggregateId: eventId,
      payload: {
        eventId,
        userId,
        rideId: dto.rideId ?? null,
        trigger: dto.trigger,
        occurredAt: new Date().toISOString(),
      },
    });

    // Ops ack clock: unacknowledged SOS older than 60s is an alert condition.
    await this.redis.set(`safety:open:${eventId}`, userId, 'EX', 3600);

    // Notify external emergency service if configured.
    let emergencyNotified = false;
    if (this.emergency) {
      try {
        const result = this.emergency.notify({
          eventId,
          userId,
          rideId: dto.rideId ?? null,
          location:
            dto.lat != null && dto.lon != null
              ? { lat: Number(dto.lat), lon: Number(dto.lon) }
              : null,
          trigger: dto.trigger,
        });
        emergencyNotified = result.acknowledged;
      } catch (err) {
        this.logger.error(
          `emergency provider failed eventId=${eventId}: ${String(err)}`,
        );
      }
    }

    this.logger.warn(
      `SOS raised eventId=${eventId} trigger=${dto.trigger} emergency=${emergencyNotified}`,
    );
    return { eventId, emergencyNotified };
  }

  /** Admin: list open SOS events. */
  async getOpenEvents(limit = 50) {
    return this.db
      .select()
      .from(safetyEvents)
      .where(eq(safetyEvents.status, 'OPEN'))
      .orderBy(desc(safetyEvents.createdAt))
      .limit(Math.min(limit, 100));
  }

  /** Admin: acknowledge an SOS event. */
  async acknowledge(eventId: string, _actorUserId: string) {
    const [row] = await this.db
      .update(safetyEvents)
      .set({ status: 'ACKNOWLEDGED', acknowledgedAt: new Date() })
      .where(eq(safetyEvents.id, eventId))
      .returning();
    if (row) await this.redis.del(`safety:open:${eventId}`);
    return row;
  }
}
