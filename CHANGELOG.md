# Changelog

All notable changes are documented here. Versioning follows Semantic Versioning.

## [0.10.0] - 2026-08-31

### Changed
- Unified response envelope for every HTTP endpoint. All responses (success and
  error) now share one shape: `{ timestamp, path, requestId, success, message,
  messageCode, data, error }`. A global `ResponseEnvelopeInterceptor` wraps every
  2xx controller return; the global `ApiErrorFilter` emits the same envelope on
  failures. `/metrics` and Swagger docs are exempt (non-JSON surfaces).
- `GET /users/profile` now throws `NotFoundException` (was `{ error: 'Not found' }`
  with HTTP 200); `POST /payments/initiate` throws `ForbiddenException` for a
  non-owner ride (was `{ error: 'Not your ride' }` with HTTP 201). Both now return
  the standard error envelope.

### Added
- `src/common/dto/api-envelope.dto.ts` (`ApiEnvelopeDto`, `ApiErrorDetailDto`) and
  `src/common/interceptors/response-envelope.interceptor.ts`.

## [0.9.0] - 2026-08-31

### Fixed
- Obbian → Roju ride-lifecycle webhooks now deliver verifiable signatures. The
  agent event forwarder signed a canonical (sorted-key) body but posted a
  `JSON.stringify` body, so Roju's `ServiceAuthGuard` (which verifies the HMAC
  over raw wire bytes) rejected every delivery. The forwarder now sends the exact
  `stableStringify` body it signs.

### Changed
- Cross-app secrets aligned for running alongside `roju-agent`: shared
  `JWT_ACCESS_SECRET` across both apps (Roju->Obbian forwarded JWTs), and a
  shared webhook HMAC secret exposed under `AGENT_WEBHOOK_HMAC_SECRET` /
  `AGENT_HMAC_SECRET` with `AGENT_WEBHOOK_URL` seeded.

## [0.8.0] - 2026-08-30

### Added
- Production observability with a private Prometheus listener, request context,
  JSON logging, HTTP/database metrics, relay/DLQ metrics, breaker state, and
  realtime connection gauges.
- Redis circuit-breaker policies, REST tracking rate limiting, multi-stop ride
  endpoints, SQL-derived waiting time, and movement-triggered cached ETA pushes.
- Incidents, cancellation penalties, device registration, in-app notifications,
  channel preferences, referrals, driver incentives, PostGIS zones, and an
  ADMIN operations surface.
- Advisory-locked partition maintenance for route points and surge history.

### Changed
- Completed rides now persist fare, GST invoice, ledger, referral, and incentive
  effects atomically. Controller/service/module files use the flat NestJS layout.
- Documentation now reflects the Drizzle runtime, ledger boundary, operational
  modules, and ADR-006 through ADR-015.
- Flat-layout cleanup: warehouse `matching/services/ride-claim.coordinator.ts`
  moved to `matching/ride-claim.coordinator.ts`, and the matching/notification
  workers moved into their respective `workers/` folders; all empty leaves
  removed.
- Logging routed from `console.*` to the Nest `Logger`: Redis module init errors
  and the notification worker's dispatch-failure points. The standalone `seed.ts`
  script retains console output.
- Extraneous narration and section banners stripped across core schemas,
  observability, realtime, and event modules; decision-critical trap comments
  retained.

### Security
- Claim writes fail closed when Redis cannot prove atomicity; monitoring remains
  private because the metrics listener is unauthenticated.

### Verification
- `tsc`, Nest build, directory-scoped ESLint, empty Jest suite, local boot, and
  throwaway live checks are the release gates. No spec/test files are retained.
- Verified on a fresh port: DI resolves, app health returns 200 (DB + Redis
  reachable), and the private metrics listener serves `obbian_` families.
- Webhook exactly-once semantics verified live (throwaway script, 11/11):
  first delivery applies and completes the payment/ride, a byte-identical
  retry is deduped, a handler failure rolls the dedupe claim back so the
  provider retry applies, and the DLQ admin retry resets a parked event's
  attempts and requeues it as PENDING.
- Multi-pod realtime delivery verified live (throwaway script, 6/6): with the
  Redis adapter ON, a rider on pod A receives a driver-location broadcast
  emitted on pod B; with the adapter OFF (negative control), no cross-pod
  delivery occurs. Stale `socket:user:*` Redis mappings were the cause of
  transient reconnect disconnects, not the adapter.
- Kafka relay delivery remains unverified locally (no broker on the dev box);
  the relay correctly logs the failed connect and parks events for retry-ondemand.

## [0.7.0] - 2026-08-24

### Added
- Roju agent quote/execute surface with short-lived price-lock ids and keyed
  idempotency.
- Durable SOS intake and the ride-event webhook bridge.
- Pickup-cell surge lookup.

### Changed
- Outbox read support, city-sharded geo indexes, Redis-backed throttling, and a
  two-connection TypeORM migration pool.

## [0.6.0] - 2026-08-23

### Added
- H3 resolution-8 cell surge with demand windows and nearby-driver supply.

## [0.3.0] - 2026-08-23

### Added
- Transactional outbox with brokerless relay mode and hot-path indexes.

### Security
- Participant ownership checks and ADMIN-only refunds.

### Changed
- Race-safe ride transitions, atomic promo redemption, and transactional driver
  registration.

## [0.2.0] - 2026-08-23

### Security
- Helmet, CORS allow-list, trust-proxy, and request body limits.

### Performance
- Parallel ride-request fan-out and asynchronous driver restoration.

## [0.1.x] - 2026-08

### Initial MVP
- OTP auth, quotes, price-locked rides, Redis-geo matching, surge, fraud guards,
  Razorpay payments, promos, ratings, analytics, scheduled rides, Swagger, and
  Render/Neon/Upstash deployment.
