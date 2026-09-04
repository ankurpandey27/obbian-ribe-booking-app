# CONTEXT.md — One-File Project Context for AI Tools

> **How to use this file:** give it to any AI tool with your prompt
> (e.g. "Read CONTEXT.md and AGENTS.md, then build feature X").
> This file = WHAT the project is. `AGENTS.md` = the RULES for changing it.
> Both live at the repo root.

---

## 1. What this project is

**Obbian Ride** — production-grade ride-booking backend (Uber/Ola/Rapido
pattern): rider books a ride → Redis-geo matching engine offers it to nearby
drivers → first accept wins (atomic claim) → live tracking → completion,
payments, settlements. Modular monolith in NestJS, engineered as a **BASE**
for 5M users / ~1M rides/day.

- **Live API docs:** `/api/v1/docs` (Swagger, non-production only)
- **Version:** see `VERSION` (currently 0.8.x)
- **License/status:** private, actively hardened

## 2. Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node 18+, NestJS 10, TypeScript |
| Database | PostgreSQL 16 + PostGIS — **Drizzle ORM** |
| Cache/realtime | Redis 7 — geo index (`GEOADD/GEORADIUS`), TTL heartbeats, atomic claims, OTP store, surge counters |
| Queues | BullMQ — matching dispatch, scheduled rides, payment processing, notifications |
| Events | Transactional outbox → Kafka; brokerless fallback (`EVENTS_BROKER_ENABLED=false`) |
| Payments | Razorpay (orders/webhooks/refunds + RazorpayX nightly settlement) |
| Maps/routing | OSRM (default, free) or Google Directions |
| Realtime | Socket.IO gateway (trip rooms) + REST tracking fallback |
| Infra | Docker; deployed on Render (Node buildpack), Neon Postgres, Upstash Redis |
| Docs/API | Swagger via `@nestjs/swagger` |

## 3. Folder structure (actual)

```
obbian-tech/
├─ AGENTS.md                  # ⭐ RULES for AI/devs changing this code — READ FIRST
├── ARCHITECTURE.md           # system design, module seams, scaling notes
├── CHANGELOG.md              # semver history (Added/Changed/Fixed/Security)
├── SECURITY.md               # security model & controls
├── README.md                 # setup, scripts, engineering invariants
├── context.md                # this file
├── rider_driver_api_flow.md  # step-by-step rider/driver API journey
├── VERSION                   # current semver
├── docs/
│  └── adr/ADR.md             # append-only architecture decision records
├── docker-compose.yml        # local postgres :5433, redis :6380, kafka :9092
├── Dockerfile / .env.example / eslint.config.mjs / jest.config.js
└─ src/
   ├─ main.ts                 # bootstrap: helmet, CORS allow-list, validation pipe, swagger gate
   ├─ app.module.ts           # composition root; global guards (Throttler→Jwt→Roles)
   ├─ config/configuration.ts # typed env registry (fail-fast JWT secrets in prod)
   ├─ common/                 # zero business logic (graduates to @app/shared)
   │  ├─ auth/                # global JwtAuthGuard, RolesGuard, @Public/@Roles/@CurrentUser
   │  ├─ database/            # DrizzleModule (runtime), schema/
    │  │  └─ schema/           # Drizzle tables + enums
   │  ├─ events/              # EventBus (best-effort), OutboxService + relay worker (durable)
   │  ├─ filters/             # ApiErrorFilter → unified error envelope
   │  ├─ interceptors/        # RequestId, idempotency
   │  ├─ queues/              # BullMQ registration (matching/scheduled/payments/notifications)
    │  ├─ redis/               # RedisModule, GeoService, circuit breaker, throttling
    │  ├─ observability/       # metrics listener, request context, logger, DB/HTTP binders
   │  └─ sms/, dto/, utils/
   ├─ modules/                # ⭐ one folder per domain = one future microservice
   │  ├─ auth/                # OTP send/verify, JWT issue/refresh-rotation, logout
   │  ├─ users/               # rider profile, saved locations
   │  ├─ drivers/             # captain onboarding, ONLINE status, GPS heartbeat, jump-validation
    │  ├─ rides/               # ⭐ state machine, fraud, scheduling, multi-stop, participant guard
   │  ├─ matching/            # geo candidates → ranked hedged offers → atomic accept claim
   │  ├─ pricing/             # fare configs, road-distance quotes (OSRM), H3-cell surge engine
   │  ├─ promos/              # atomic per-user promo redemption (Redis INCR + compensation)
   │  ├─ payments/            # Razorpay orders/capture/refund webhooks, nightly driver settlement
   │  ├─ tracking/            # live position + ETA (30s cache), Socket.IO gateway
   │  ├─ ratings/             # aggregate rider/driver ratings from completed rides
   │  ├─ analytics/           # ops dashboard aggregates
    │  ├─ notifications/       # FCM push / SMS (MSG91/Twilio) / SendGrid worker
    │  ├─ health/               # liveness + DB/Redis readiness probe
    │  ├─ compliance/           # documents, vehicles, expiry gate
    │  ├─ safety/               # SOS intake
    │  ├─ ledger/               # driver wallet ledger and reconciliation
    │  ├─ ops/                  # incidents and cancellation penalties
    │  ├─ growth/               # referrals, incentives, PostGIS zones
    │  └─ admin/                # ADMIN recovery and moderation
   ├─ shared/
   │  ├─ contracts/           # ports (e.g. USER_LOOKUP) — hexagonal seams
   │  ├─ events/              # topic names + event payload contracts
   │  └─ types/               # shared enums (RideStatus, UserRole, …)
   └─ migrations/             # HAND-WRITTEN NNN-*.ts (001-init … 003-indexes+outbox)
```

Feature controller, service, and module files sit directly in the module folder;
`dto/`, `entities/`, `guards/`, `workers/`, and `gateways/` stay nested.

## 4. Module → future microservice map

| Module(s) | Future service |
|---|---|
| auth + users + drivers | user-service |
| rides (+scheduled, fraud) | trip-service |
| matching | matching-service |
| tracking | tracking-service |
| payments + settlement | payment-service |
| ledger | ledger-service |
| pricing, promos | pricing-service |
| ratings, analytics | consumers/read-models |
| compliance, safety, ops | ops/user-service |
| growth | growth-service |
| notifications | notification-service |

Rule of thumb while coding: writes cross boundaries only via events
(transactional outbox); reads may call exported services today.

## 5. API surface (`/api/v1`, Swagger-tagged)

**Public (no token):**
- `POST /auth/send-otp` · `POST /auth/verify-otp` (throttled 3 & 5 per 10min)
- `POST /auth/refresh` (10/min) · `POST /auth/logout`
- `GET /health` · `GET /maps/*` (autocomplete, reverse-geocode, route)
- `GET /rides/quote` · `POST /payments/webhook` (signature-verified)

**Authenticated (Bearer JWT):**
- `GET|PUT /users/profile` · `GET|POST /users/saved-locations`
- `GET /users/:userId/rating`
- `POST /rides/request` (use-case: fraud→quote→price-lock→promo→create)
- `POST /rides/schedule` · `GET /rides/scheduled` · `DELETE /rides/scheduled/:id`
- `GET /rides/active` · `GET /rides/history` · `GET /rides/:rideId` 🔒participants
- `PUT /rides/:rideId/cancel` 🔒participants · `POST /rides/:rideId/rate` 🔒participants
- `GET /rides/:rideId/tracking` · `GET /rides/:rideId/eta` 🔒participants
- `POST /promo/validate` · `GET /promo/available`

**Driver role required (`role=DRIVER` in JWT):**
- `POST /drivers/register` (any user → promotes role; re-login for DRIVER token)
- `PUT /drivers/status` · `POST /drivers/location` (3–5s heartbeat)
- `GET /drivers/me` · `GET /drivers/:driverId` (auth'd users)
- `POST /drivers/accept-ride` (atomic claim) · `POST /drivers/reject-ride`
- `POST /drivers/rides/:rideId/{arrived|start|complete}` 🔒assigned driver

**Agent surface (Roju voice/chat agent, ADR-00X):**
- `POST /agent/rides/quote` · `POST /agent/rides/execute` (forwarded user JWT + optional X-Roju-* HMAC; idempotent by key; price-lock quote ids)

**Safety:**
- `POST /safety/sos` (durable safety_events + SAFETY_EVENTS outbox topic; ops fan-out consumer)
- `POST|GET /ops/incidents/*` and `GET|POST /ops/penalties/*` (authenticated;
  admin lifecycle actions are role-guarded)
- `POST|GET|DELETE /notifications/devices`, `GET /notifications`, and channel
  preference endpoints
- `/growth/*` referrals, driver incentives, and admin zone management
- `/admin/*` DLQ recovery, compliance queue, refunds, moderation, invoice gaps,
  and ledger drift reports

**Pricing extra:**
- `GET /rides/surge?city=&lat=&lon` (current surge multiplier)

**Payments:**
- `POST /payments/initiate` · `POST /payments/verify` (owner-checked)
- `GET /payments/:rideId` 🔒participants
- `POST /payments/:rideId/refund` — **ADMIN only**

🔒 = ownership-enforced via `RideParticipantGuard`.

## 6. Core patterns (how things are done here — copy these)

1. **Thin controller** → one service use-case method (`RidesService.requestRide()`).
2. **Atomic state transition**: conditional `UPDATE … WHERE id=:id AND status=:from`
   `.returning()`; empty result ⇒ `409 Conflict`. Never blind updates.
3. **Transactional outbox**: state change + event row committed in ONE tx;
   relay worker drains to Kafka with `FOR UPDATE SKIP LOCKED`.
4. **Redis atomic claims**: ride acceptance = `SET ride:claim:{id} NX EX 30`.
5. **TTL-based liveness**: driver heartbeat key expires in 90s; matching filters
   candidates by heartbeat existence (no cron).
6. **Compensation**: promo redeem (INCR) is released if the subsequent create fails.
7. **Fraud guards** before dispatch: velocity 5/h, concurrency 2, duplicate pickup 3/10min.
8. **H3 cell surge**: demand keyed per res-8 cell; supply probed near cell centroid.
9. **Money**: decimal columns, nearest ₹0.50 rounding, Razorpay paise ×100 at gateway.
10. **Ownership**: resource-scoped routes carry `RideParticipantGuard`; refunds are ADMIN-only.

## 7. Data model (10 tables, all camelCase columns)

`users` · `refresh_tokens` · `saved_locations` · `drivers` · `fare_configs` ·
`rides` · `scheduled_rides` · `payments` · `promos` · `outbox_events` ·
`ride_stops` · `ride_route_points` · `ride_reviews` · `wallet_ledger` ·
`invoices` · `incidents` · `cancellation_penalties` · `user_devices` ·
`notifications` · `referral_codes` · `referral_redemptions` ·
`driver_incentives` · `areas` · `surge_zones_history`

Enums (PG types): `user_role(RIDER/DRIVER/ADMIN)` ·
`ride_type(CABX_SAVER/CABX/CABXL/COMFORT/AUTO/TWO_WHEELER)` ·
`ride_status(REQUESTED/MATCHING/ACCEPTED/ARRIVED/IN_PROGRESS/COMPLETED/CANCELLED)` ·
`driver_status(ONLINE/OFFLINE/ON_RIDE)` · `payment_status` · `payment_method` ·
`cancellation_reason` · `outbox_status`.

Ride state machine:
`REQUESTED → MATCHING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED`,
any pre-completed state → `CANCELLED` (reasons: USER_CANCELLED /
DRIVER_CANCELLED / NO_DRIVER_FOUND / SYSTEM).

Hot indexes: `rides(riderId,status,createdAt DESC)`,
`rides(driverId,status,createdAt DESC)`, `rides(createdAt)`,
`outbox_events` partial-dispatch index.

## 8. Redis keys

| Key | Purpose / TTL |
|---|---|
| `drivers:geo` | GEOADD pin of every pinging driver (match source of truth) |
| `driver:{id}:heartbeat` | EXISTS-filtered at match time · 90s TTL |
| `driver:{id}:location` | last position JSON for tracking · 300s |
| `offer:{rideId}:{driverId}` | hedged offer · 30s |
| `ride:claim:{rideId}` | NX accept claim · 30s |
| `surge:demand:{city}:{h3cell}` / `surge:multiplier:…` | surge window 10min / cache 60s |
| `promo:{id}:user:{uid}` | per-user usage INCR counter · 90d |
| `otp:*` / `fraud:*` | hashed OTP + attempt counters / velocity windows |

## 9. Environment & deployment

- All config via env (`.env.example` documents every var). Production fails
  fast without `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`.
- Managed mode: set `DATABASE_URL` (Neon) + `REDIS_TLS=true` (Upstash).
- Render Node buildpack: build `npm ci --include=dev && npm run build`,
  start `npm run start:prod`; migrations auto-run on boot.
- `CORS_ORIGINS` empty = deny browsers; mobile unaffected.
- `EVENTS_BROKER_ENABLED=false` on free tier (outbox drains without Kafka).

## 10. Demo data (after seed)

- Rider: `+919000000000` (Aarav Sharma) — dev OTP `123456` (OTP_PROVIDER=dev)
- Drivers: `+919010000000..033`; test drivers exist too
  (`+919988776656` AUTO Bajaj RE completed an e2e ride)
- Promos: `WELCOME20` (20%, cap ₹100), `FIRST50`, `DEMO10`
- Seeded fares: Delhi × all 6 ride types

## 11. Commands

```bash
docker compose up -d      # postgres :5433, redis :6380, kafka :9092
npm ci && npm run migration:run && npm run seed && npm run seed:redis
npm run start:dev         # http://localhost:3000/api/v1/docs
npm run lint && npm test  # gates — must pass before every commit/push
npm run migration:generate|run|revert
```

## 12. Important documents index (read order for an AI)

| File | Why read it |
|---|---|
| **`AGENTS.md`** | ⭐ THE RULES. NestJS structure, security, concurrency, data, testing rules. Non-negotiable. |
| `ARCHITECTURE.md` | System design, module seams, matching pipeline, event delivery contract, 5M-user scaling notes |
| `docs/adr/ADR.md` | WHY decisions were made (modular monolith, Drizzle, outbox, geo strategy, money rules). Append-only. |
| `SECURITY.md` | Authn/z model, injection/throttle/ownership controls, known gaps |
| `CHANGELOG.md` | What changed per version; follow its format for new entries |
| `rider_driver_api_flow.md` | End-to-end API journey examples (request/response level) |
| `README.md` | Setup, commands, engineering invariants checklist |
| `VERSION` | Current semver — bump per CHANGELOG |

## 13. Non-negotiables recap (the AI TL;DR)

1. Thin controllers; business logic lives in service use-case methods.
2. Every ride/payment state change: ONE transaction = conditional update + outbox row.
3. New query pattern ⇒ composite index migration in the same PR.
4. Ownership guard on every id-addressed route; ADMIN-only refunds.
5. Parameterized SQL only; validated DTOs only (whitelist enforced globally).
6. Money: no float math; idempotent ops; Razorpay signatures verified server-side.
7. Durable events only via outbox; never direct broker publish from request paths.
8. `build + test + lint` green before finishing any task; verify every bug fix
   with a throwaway script and delete it afterwards.
9. Update CHANGELOG (every change) and ADR (architecture changes); bump VERSION.
10. When in doubt about money, auth, or state transitions — STOP and ask.
