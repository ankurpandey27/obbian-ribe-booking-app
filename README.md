# Obbian Ride — Ride-Booking Backend

Production-grade ride-booking backend (NestJS modular monolith) for the Obbian
platform: rider + driver journeys, live matching, dynamic pricing, payments,
tracking, and settlements. Designed and hardened as the **base** of the
product — target scale: **5M users / ~1M rides/day**.

> **Version:** see `VERSION` (semver) · history in [`CHANGELOG.md`](./CHANGELOG.md)
> **Architecture:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — module map, ride state
> machine, matching pipeline, event delivery contract, scaling notes
> **Decisions:** [`docs/adr/ADR.md`](./docs/adr/ADR.md) — append-only ADR log
> **Security model:** [`SECURITY.md`](./SECURITY.md)

## Stack

| Layer    | Tech                                                          |
| -------- | ------------------------------------------------------------- |
| Runtime  | Node.js 18+, NestJS 10, TypeScript                            |
| Database | PostgreSQL 16 + PostGIS (TypeORM; Drizzle migration planned)  |
| Cache    | Redis 7 (ioredis) — geo index, heartbeats, offers, claims     |
| Queues   | BullMQ (Redis-backed) — matching dispatch, scheduled rides    |
| Events   | Transactional outbox → Kafka (brokerless mode supported)      |
| Payments | Razorpay (orders, webhooks, refunds, settlements)             |
| Maps     | OSRM (default, free) or Google Directions                     |
| API docs | Swagger UI at `/api/v1/docs` (JSON at `/api/v1/docs-json`)    |

## Domain modules (= future microservice seams)

```
auth        OTP login, JWT access/refresh rotation, roles
users       rider profiles, saved locations
drivers     captain onboarding, status, heartbeat location stream
rides       ride state machine (race-safe transitions), history, scheduling
matching    Redis-geo candidates -> hedged offers -> atomic accept claim
pricing     fare config, road-distance quotes (OSRM), surge engine
promos      atomic per-user promo redemption
payments    Razorpay orders/webhooks/refunds + driver settlement
tracking    live position + ETA (Socket.IO gateway + REST fallback)
ratings     aggregate rider/driver ratings
analytics   ops dashboard aggregates
```

Full boundary rules and extraction plan: [ARCHITECTURE.md §2](./ARCHITECTURE.md).

## Quick start (local)

```bash
cp .env.example .env          # fill values (defaults work with docker-compose)
docker compose up -d          # postgres :5433, redis :6380, kafka :9092
npm ci
npm run migration:run         # schema + indexes
npm run seed                  # demo riders/drivers/fares/promos
npm run seed:redis            # hydrate driver geo pool
npm run start:dev             # http://localhost:3000/api/v1/docs
```

Demo login: `POST /auth/send-otp` with `+919000000000`, OTP `123456`
(dev provider). Full rider/driver API journey:
[`rider_driver_api_flow.md`](./rider_driver_api_flow.md).

## Scripts

| Command                    | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `npm run build`            | compile to `dist/`                         |
| `npm run lint`             | ESLint (+prettier) over `src`              |
| `npm test`                 | unit tests (jest)                          |
| `npm run test:e2e`         | e2e suite                                  |
| `npm run migration:run`    | apply pending migrations                   |
| `npm run seed` / `seed:redis` | demo data (DB / geo pool)               |

## Engineering invariants (review checklist)

1. Every ride state change = one transaction: conditional status update +
   outbox event row.
2. Money operations are idempotent; refunds are ADMIN-only.
3. No module reaches into another module's repositories.
4. All SQL parameterized; all input via validated DTOs (whitelist strict).
5. New hot queries ship with composite indexes in a numbered migration.
6. Behavior changes update `CHANGELOG.md`; architectural changes add an ADR.

## Deployment

Render (Node buildpack): build `npm ci --include=dev && npm run build`,
start `npm run start:prod`. Migrations auto-run on boot (`migrationsRun`).
Managed Postgres via `DATABASE_URL` (Neon), Redis via TLS envs (Upstash).
Set `CORS_ORIGINS` when browser clients come online;
`EVENTS_BROKER_ENABLED=true` once Kafka is provisioned.
