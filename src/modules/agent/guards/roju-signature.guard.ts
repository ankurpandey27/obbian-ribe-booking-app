import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { createHmac } from 'crypto';

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** Deterministic JSON: identical key order on both sides of the wire. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function signPayload(
  secret: string,
  timestamp: string,
  body: unknown,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${stableStringify(body)}`)
    .digest('hex');
}

/**
 * Service-to-service signature for Roju→Obbian agent calls. Enforced only
 * when AGENT_HMAC_SECRET is configured (production); dev runs without it.
 * Signature covers a canonical (sorted-key) JSON body + timestamp.
 */
@Injectable()
export class RojuSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.AGENT_HMAC_SECRET ?? '';
    if (!secret) return true; // dev mode — user JWT still required globally

    const request = context.switchToHttp().getRequest();
    const timestamp = request.headers['x-roju-timestamp'];
    const signature = request.headers['x-roju-signature'];
    if (typeof timestamp !== 'string' || typeof signature !== 'string') {
      throw new BadRequestException('Missing service signature');
    }
    const ts = Number(timestamp);
    if (
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) > TIMESTAMP_WINDOW_MS
    ) {
      throw new BadRequestException('Stale service timestamp');
    }
    const expected = signPayload(secret, timestamp, request.body ?? {});
    if (expected.length !== signature.length || expected !== signature) {
      throw new BadRequestException('Invalid service signature');
    }
    return true;
  }
}
