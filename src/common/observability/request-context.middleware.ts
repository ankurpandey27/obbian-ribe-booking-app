import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Inbound correlation ids are untrusted input that gets echoed into logs and
 * response headers: a value with CR/LF forges extra log lines (fabricated
 * audit entries), and a huge one grows logs unboundedly. Anything outside
 * this alphabet or cap is discarded — correlation is best-effort, a forged
 * log line is not recoverable.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Establishes the per-request ALS context. Mounted as the FIRST middleware so
 * failures raised before Nest's interceptor chain (body-parser 413, malformed
 * JSON 400) still carry an id — the cases a client most needs it for.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const requestId =
    candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

  // Normalised onto the request so downstream code (ApiErrorFilter) reads the
  // sanitised value, never the raw client-supplied one.
  req.headers[REQUEST_ID_HEADER] = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  RequestContext.run({ requestId }, () => next());
}
