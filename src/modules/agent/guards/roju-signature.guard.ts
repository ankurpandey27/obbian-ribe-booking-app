import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

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
 * Service-to-service signature for Roju→Obbian agent calls. ALWAYS enforced —
 * if AGENT_HMAC_SECRET is unset the guard throws rather than failing open.
 * Signature covers a canonical (sorted-key) JSON body + timestamp.
 */
@Injectable()
export class RojuSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.AGENT_HMAC_SECRET ?? '';
    // Fail closed: an insecure deployment must not silently accept unsigned
    // agent traffic. Configure AGENT_HMAC_SECRET in every environment.
    if (!secret) {
      throw new UnauthorizedException('Service signature not configured');
    }

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
    // Constant-time comparison to avoid timing side-channels.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const signatureBuf = Buffer.from(signature, 'utf8');
    if (
      expectedBuf.length !== signatureBuf.length ||
      !timingSafeEqual(expectedBuf, signatureBuf)
    ) {
      throw new BadRequestException('Invalid service signature');
    }
    return true;
  }
}
