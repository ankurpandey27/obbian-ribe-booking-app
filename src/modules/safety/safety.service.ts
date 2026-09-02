import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { InjectRedis } from '../../common/redis/redis.decorator';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { safetyEvents } from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import type { RaiseSosDto } from './dto/safety.dto';

/**
 * SOS intake (ADR-00X): durable record + outbox event so ops/consumer
 * surfaces can page a human. Never auto-resolves; never rate-limited beyond
 * the global throttle.
 */
@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly outbox: OutboxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async raiseSos(
    userId: string,
    dto: RaiseSosDto,
  ): Promise<{ eventId: string }> {
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

    this.logger.warn(`SOS raised eventId=${eventId} trigger=${dto.trigger}`);
    return { eventId };
  }
}
