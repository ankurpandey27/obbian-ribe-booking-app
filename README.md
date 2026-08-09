# Obbian Ride — Ride-Booking Backend

Production-style ride-booking backend (NestJS modular monolith) for the Obbian
platform: rider + driver apps, live matching, dynamic pricing, payments,
tracking, and settlements.

## Stack

| Layer      | Tech                                                              |
| ---------- | ----------------------------------------------------------------- |
| Runtime    | Node.js 18+, NestJS 10, TypeScript                                |
| Database   | PostgreSQL 16 + PostGIS (TypeORM)                                 |
| Cache      | Redis 7 (ioredis) — geo index, OTP, offers, surge, idempotency    |
| Queues     | BullMQ (Redis-backed) — matching, notifications, settlements      |
| Events     | Kafka (optional) + in-process event bus fallback                  |
| Payments   | Razorpay (orders, payouts)                                        |
| Maps       | OSRM (default, free) or Google Directions                         |
| API docs   | Swagger UI at `/api/v1/docs` (JSON at `/api/v1/docs-json`)        |

## Architecture

```
auth (OTP + JWT, riders/drivers)
 ├─ drivers      — onboarding, availability, vehicle, ratings
 ├─ rides        — request → quote lock → state machine, fraud guards
 ├─ matching     — BullMQ dispatch, geo candidates, atomic accept claim
 ├─ pricing      — fare config, road distance quotes, dynamic surge
 ├─ payments     — Razorpay orders, webhooks, refunds, settlements
 ├─ tracking     — live driver position (socket gateway + REST fallback)
 ├─ maps         — OSRM/Google provider abstraction with route caching
 ├─ analytics    — admin KPIs over the ride lifecycle
 └─ notifications — BullMQ workers (push/SMS/email adapters)
```

Ride lifecycle: `REQUESTED → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED`
(plus `CANCELLED`; `MATCHING` exists in the enum but the ride stays
`REQUESTED` during dispatch and jumps to `ACCEPTED` on a driver claim).
Matching is hedged by default: offers go to the top N drivers simultaneously
and the first `SET NX` claim wins — double acceptance is impossible; the
BullMQ job retry is safe by design.

## Getting started

### 1. Infra (Docker)

```bash
docker compose up -d postgres redis kafka   # kafka optional
```

Mapped ports: Postgres `5433`, Redis `6380` (see `.env.example`), Kafka
`9092`. On this machine the containers run inside WSL (`wsl docker ps`) and
the app on Windows reaches them via `localhost`. The default Redis on `6379`
is a different instance — the app only ever talks to `6380`.

### 2. Env + config

```bash
cp .env.example .env
```

Defaults are dev-friendly: OTP is `123456` (`OTP_PROVIDER=dev`), maps use the
free OSRM public server, surge is off. Enable real providers as needed
(MSG91/Twilio, Google Maps, Razorpay, FCM).

### 3. DB + run

```bash
npm install
npm run migration:run        # or: npm run migration:generate -- <Name>
npm run seed                 # riders/drivers/fares/promos + Redis geo pool
npm run start:dev            # http://localhost:3000/api/v1
```

> **Seed is required for matching** — it writes the Redis geo pool
> (`drivers:geo`) that the dispatch engine queries. A running app against an
> empty pool logs `Ride … cancelled: no drivers`. Re-run after any Redis reset.

Swagger: http://localhost:3000/api/v1/docs (JWT bearer `access-token`).

### 4. Run a demo ride

Everything is scripted for 8 cities (Delhi, Noida, Gurugram, Bangalore,
Mumbai, Hyderabad, Pune, Chennai) — seeded accounts per city, driver ONLINE
with a geo position:

```bash
powershell -File scripts/demo-flow.ps1 -City Bangalore -RideType CABX
```

The script walks the whole lifecycle: rider OTP login → saved locations →
quote → request → driver accept → ARRIVED → IN_PROGRESS → COMPLETED →
driver profile. Try `-City Mumbai`, `-RideType CABXL|COMFORT|AUTO|...`.

Notes:
- Dev OTP is `123456` and **single-use** — every login needs a fresh
  `POST /api/v1/auth/send-otp` before `verify-otp`.
- Matching is hedged to the top-3 scored drivers; the script tries each
  driver in the city until one accepts.
- Fraud guards will block rapid re-runs from the same rider/location
  (`5/hour` velocity, `max 2` active rides, `4 in 10 min` same location).
  The script jitters pickup coordinates per run; wait ~35s for unaccepted
  rides to auto-cancel (offer TTL) before retrying the same rider.

## Testing

```bash
npm run test                 # unit tests (32, ts-jest, no infra needed)
npm run test:cov             # unit + coverage
npm run test:e2e             # e2e lifecycle suite — needs Docker + OSRM up
npm run lint                 # eslint (strict), build: npm run build
```

## Feature notes

- **Pricing** — quotes use road distance/duration (never haversine), fare =
  `base + km×rate + min×rate` floored at minimum, rounded to ₹0.50, layered
  with dynamic surge (demand ÷ online supply, stepped + cached).
- **Surge** — Redis demand counter per city vs ONLINE driver count; multiplier
  cached so concurrent quotes agree.
- **Fraud guards** — per-hour velocity, concurrent active rides, duplicate
  pickup window; fail-open on Redis errors.
- **Scheduled rides** — book ahead (max 24h), released to the dispatch queue
  when due.
- **Matching offers** — carry `estimatedFare` + `estimatedEarnings`
  (fare minus commission) so drivers decide with real numbers.
- **Notifications** — real provider adapters behind the BullMQ worker:
  FCM HTTP v1 push (service-account JWT, no SDK), SMS via the shared
  MSG91/Twilio client, SendGrid email. Channels fail soft and skip
  cleanly in dev when credentials are absent. Push needs
  `data.deviceToken` on the job (apps send it; persist per user with a
  migration for multi-device).
- **Settlements** — RazorpayX daily payout cron (03:00, commission 20%).

## Provider checklist (production)

| Provider   | Env keys                                                      |
| ---------- | ------------------------------------------------------------- |
| OTP SMS    | `OTP_PROVIDER=msg91\|twilio` + `MSG91_*` / `TWILIO_*`         |
| Maps       | `MAPS_PROVIDER=google` + `GOOGLE_MAPS_API_KEY` (else OSRM)    |
| Payments   | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Push       | `FCM_SERVICE_ACCOUNT_JSON` (path to service account)          |
| Email      | `SENDGRID_API_KEY`, `NOTIFICATIONS_FROM_EMAIL`                |
| Errors     | `SENTRY_DSN` (optional)                                       |
