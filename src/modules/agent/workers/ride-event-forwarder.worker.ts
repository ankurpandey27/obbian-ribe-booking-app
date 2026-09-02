import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRedis } from '../../../common/redis/redis.decorator';
import type Redis from 'ioredis';
import { OutboxService } from '../../../common/events/outbox.service';
import { DriversService } from '../../drivers/drivers.service';
import { UsersService } from '../../users/users.service';
import { RidesService } from '../../rides/rides.service';
import {
  mapRideEvent,
  type AgentEventPayload,
  type DriverEnrichment,
  type OutboxRow,
} from './ride-event-forwarder.types';
import { signPayload, stableStringify } from '../guards/roju-signature.guard';

const CURSOR_KEY = 'agent:webhook:cursor_ts';
/** Overlap window: a crash re-reads a few minutes of rows; agent dedupes. */
const OVERLAP_MS = 120_000;
const BATCH = 25;
/**
 * Per-event retry tracking. Each event that fails POST delivery increments a
 * Redis counter (TTL = 1 hour). Events exceeding MAX_RETRIES are parked in a
 * DLQ key and skipped so a persistently-failing event (e.g. agent down) does
 * not block the cursor and stall delivery of subsequent events. Ops can inspect
 * and replay the DLQ.
 */
const MAX_RETRIES = 5;
const RETRY_TTL_SEC = 3600;
const DLQ_KEY = 'agent:webhook:dlq';

/**
 * Bridges Obbian ride lifecycle facts to the Roju agent webhook
 * (ADR-00X). At-least-once with cursor+overlap; the agent dedupes on
 * eventId. Driver enrichment is best-effort — delivery never blocks on it.
 */
@Injectable()
export class RideEventForwarderWorker {
  private readonly logger = new Logger(RideEventForwarderWorker.name);
  private running = false;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly outbox: OutboxService,
    private readonly drivers: DriversService,
    private readonly users: UsersService,
    private readonly ridesService: RidesService,
  ) {}

  @Interval('agent-event-forwarder', 3000)
  async forward(): Promise<void> {
    const url = process.env.AGENT_WEBHOOK_URL ?? '';
    if (!url || this.running) return;
    // Leader lock: with N API replicas, only ONE instance forwards per tick —
    // otherwise webhook egress multiplies by N (agent dedupes, but why pay).
    const lockKey = 'agent:forwarder:leader';
    const token = `${process.pid}-${Date.now()}`;
    const got = await this.redis.set(lockKey, token, 'PX', 10_000, 'NX');
    if (got !== 'OK') return;
    this.running = true;
    try {
      await this.forwardBatch(url);
    } catch (err) {
      this.logger.warn(`agent forward cycle failed: ${String(err)}`);
    } finally {
      // release only if we still own it
      const current = await this.redis.get(lockKey);
      if (current === token) await this.redis.del(lockKey);
      this.running = false;
    }
  }

  private async forwardBatch(url: string): Promise<void> {
    const storedCursor = await this.redis.get(CURSOR_KEY);
    const since = storedCursor
      ? new Date(new Date(storedCursor).getTime() - OVERLAP_MS)
      : new Date(Date.now() - 10 * 60_000);

    const rows = await this.outbox.listRideEventsSince(since, BATCH);
    let newest = storedCursor;

    for (const row of rows as unknown as OutboxRow[]) {
      const enrichment = await this.enrich(row);
      const mapped = mapRideEvent(row, enrichment);
      if (!mapped) {
        newest = this.advance(newest, row.createdAt);
        continue;
      }
      // Attach the one-time boarding code to the driver_arrived event so the
      // agent can speak it to the rider (AI/voice pickup verification).
      if (mapped.event === 'ride.driver_arrived') {
        const code = await this.ridesService.getBoardingCode(mapped.rideId);
        if (code) {
          mapped.data = { ...mapped.data, boardingCode: code };
        }
      }
      // Skip events that have exhausted retries — they are parked in the DLQ
      // and must not block the cursor or subsequent events.
      const retryKey = `agent:webhook:retry:${mapped.eventId}`;
      const retries = Number((await this.redis.get(retryKey)) ?? '0');
      if (retries >= MAX_RETRIES) {
        await this.redis.lpush(DLQ_KEY, mapped.eventId);
        await this.redis.ltrim(DLQ_KEY, 0, 999);
        this.logger.warn(
          `event ${mapped.eventId} parked in DLQ after ${retries} failures`,
        );
        newest = this.advance(newest, row.createdAt);
        continue;
      }
      const ok = await this.post(url, mapped);
      if (!ok) {
        // Track the failure; the event stays at the cursor for retry next tick.
        await this.redis.incr(retryKey);
        await this.redis.expire(retryKey, RETRY_TTL_SEC);
        return; // stop batch; retry next tick from same cursor
      }
      // Success — clear any prior retry count for this event.
      await this.redis.del(retryKey);
      newest = this.advance(newest, row.createdAt);
    }
    if (newest && newest !== storedCursor) {
      await this.redis.set(CURSOR_KEY, newest);
    }
  }

  /** Best-effort driver snapshot for driver_assigned; never blocks delivery. */
  private async enrich(row: OutboxRow): Promise<DriverEnrichment | undefined> {
    if (row.eventType !== 'RIDE_ACCEPTED') return undefined;
    try {
      const driverId = String(row.payload?.['driverId'] ?? '');
      if (!driverId) return undefined;
      const [driver, user] = await Promise.all([
        this.drivers.getProfile(driverId).catch(() => null),
        this.users.findById(driverId).catch(() => null),
      ]);
      if (!driver) return undefined;
      return {
        driverName:
          [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
          undefined,
        vehicle:
          [driver.vehicleModel, driver.vehicleColor, driver.vehicleType]
            .filter(Boolean)
            .join(' ') || undefined,
        plate: driver.vehicleRegistration,
      };
    } catch {
      return undefined;
    }
  }

  private advance(current: string | null, createdAt: Date): string {
    const iso = createdAt.toISOString();
    return !current || iso > current ? iso : current;
  }

  private async post(
    url: string,
    payload: AgentEventPayload,
  ): Promise<boolean> {
    const secret = process.env.AGENT_WEBHOOK_HMAC_SECRET ?? '';
    const timestamp = Date.now().toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (secret) {
      headers['x-obbian-timestamp'] = timestamp;
      headers['x-obbian-signature'] = signPayload(secret, timestamp, payload);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      // Send the EXACT canonical body that was signed — Roju's ServiceAuthGuard
      // verifies the HMAC over raw wire bytes, so body must equal stableStringify.
      const body = stableStringify(payload);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch (err) {
      this.logger.warn(`agent webhook POST failed: ${String(err)}`);
      return false;
    }
  }
}
