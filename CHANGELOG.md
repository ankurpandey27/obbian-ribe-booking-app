# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/) until v1.0,
after which MAJOR bumps gate breaking API/schema changes.

## [0.3.0] - 2026-08-23

### Added
- **Transactional outbox** (`outbox_events` + relay worker): ride lifecycle
  events are committed in the same Postgres transaction as the state change
  and drained to Kafka at-least-once (`FOR UPDATE SKIP LOCKED`, crash-safe).
- Brokerless mode: `EVENTS_BROKER_ENABLED=false` (default) drains events
  without a broker so free-tier deploys stay clean.
- Composite indexes for hot paths: `rides(riderId,status,createdAt)`,
  `rides(driverId,status,createdAt)`, `rides(createdAt)` (migration 003).

### Security
- `RideParticipantGuard`: ride details / cancel / rate / tracking /
  payment-receipt now require the caller to be the rider or assigned driver.
- Payment refunds restricted to `ADMIN` role.

### Changed
- Ride transitions are race-safe: conditional `UPDATE … WHERE status=<from>`;
  concurrent losers receive `409 Conflict`.
- Promo redemption is atomic (Redis `INCR`) with compensation on failure;
  the old validate-then-markUsed pair allowed over-redemption under load.
- Driver registration is transactional (profile + role promotion atomic).

## [0.2.0] - 2026-08-23

### Security
- helmet security headers, CORS allow-list (`CORS_ORIGINS`), trust-proxy,
  JSON body cap (64kb).

### Performance
- Ride request fan-out (`Promise.all`) for fraud guard / fare config / quote.
- Trip-completion driver restore moved off the response path.

## [0.1.x] - 2026-08

### Initial MVP
- OTP auth (JWT access/refresh), quotes with OSRM road distance, price-locked
  rides, Redis-geo matching with hedged offers and atomic claims, surge,
  fraud guards, Razorpay payments, promos, ratings, analytics, scheduled
  rides, Swagger docs, Render/Neon/Upstash deployment.
