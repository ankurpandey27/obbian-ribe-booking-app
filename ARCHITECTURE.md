# Architecture

> Status: **BASE v0.3** — modular monolith, microservice-extraction-ready.
> Design target: **5M users / ~1M rides/day within 3–4 months.**

## 1. System shape

```
Flutter apps ─┐
Next.js web ──┼─► REST /api/v1 (Swagger) ──► NestJS modular monolith
              │                                │
              └── Socket.IO (trip rooms) ◄─────┘
                                   │
        ┌──────────────┬───────────┼──────────────┬─────────────┐
   PostgreSQL      Redis         BullMQ         Kafka*      Razorpay
   (state)      (geo/claims/   (matching,     (outbox →     (payments)
                 heartbeats)    scheduled)     events)*
```
\* Kafka optional — see ADR-003.

## 2. Module map (= future service seams)

| Module | Owns | Future service |
|---|---|---|
| auth | OTP, JWT issue/refresh/rotation | user-service |
| users | rider profiles, saved locations | user-service |
| drivers | captain profiles, KYC, status, location | user-service |
| trips (rides) | ride state machine, history | trip-service |
| matching | candidate search, offers, atomic claim | matching-service |
| tracking | live positions, ETA, WS gateway | tracking-service |
| payments | orders, webhooks, settlement, refunds | payment-service |
| wallets/subscriptions/settlement | money movement | payment-service |
| pricing/promos | fare config, quotes, promos | shared pricing svc |
| ratings/analytics/notifications | read models & fan-out | consumers |

**Boundary rules (enforced by review):**
1. Modules communicate via services they import through module `exports` —
   never by reaching into another module's repositories.
2. Durable facts are emitted only via the transactional outbox.
3. `common/` holds zero business logic.

## 3. The ride state machine

```
REQUESTED → MATCHING → ACCEPTED → ARRIVED → IN_PROGRESS → COMPLETED
     ↘───────────┴───────────┴───────────┴─────────────↙ CANCELLED
```

- Transitions validated by `RideStateMachine` **and** enforced atomically:
  `UPDATE rides SET status=:to WHERE id=:id AND status=:from` — concurrent
  losers get `409`, so double-accept/double-complete is impossible.
- Each transition writes its outbox event in the same transaction.

## 4. Matching pipeline

```
POST /rides/request
  ├─ tx: insert ride(REQUESTED) + outbox(RIDE_REQUESTED)
  ├─ BullMQ job match-{rideId} (jobId = idempotent dedupe)
▼ worker
findMatchableDrivers(lon, lat, radius, vehicleType):
  1. GEORADIUS drivers:geo          (Redis, O(log n))
  2. heartbeat EXISTS filter        (pipelined; dead captains excluded)
  3. status=ONLINE + vehicleType    (Postgres)
→ rank (rating×40 + proximity×60) → top-N
→ hedged offers: offer:{ride}:{driver} keys, TTL 30s
→ accept: SET ride:claim:{ride} NX EX  → first writer wins
→ finalizeMatch: ride→ACCEPTED, driver→ON_RIDE, offer keys cleared
→ no claim in window → CANCELLED(NO_DRIVER_FOUND); empty candidate set → instant cancel
```

## 5. Event delivery

| Class of event | Path | Guarantee |
|---|---|---|
| Ride lifecycle facts | Postgres outbox → relay → Kafka | at-least-once, ordered per aggregate |
| Matching signals (offers, responses) | EventBus direct | best-effort (ephemeral by design) |
| Trip updates to clients | Socket.IO room + REST fallback | latest-wins |

Consumers must be idempotent on `event.id`.

## 6. Data & scaling notes (5M users)

- **Reads**: composite indexes cover every hot query; history/polls hit
  `(rider,status,created)` prefix — no scans. Analytics should move to a
  replica before it competes with OLTP.
- **Writes**: GPS pings never touch Postgres on the hot path (Redis only,
  TTL'd). Ride rows are one write per transition (~7/ride).
- **Redis**: geo zset + heartbeat + location cache ≈ 300 B/captain;
  200K concurrent captains ≈ 60 MB. Next scaling step: shard geo key per city.
- **Connection pool**: capped (`max:20`) per instance; scale horizontally
  behind the ALB; PgBouncer before >50 instances.
- **Known next steps**: Drizzle migration (ADR-002), H3 cell surge,
  read-replica for analytics/ratings.

## 7. Security model

- Global JWT guard (`@Public()` opt-out), role guard, throttle guard.
- Resource ownership via guards (`RideParticipantGuard`), not controller ifs.
- Input: class-validator whitelist + forbidNonWhitelisted globally; all SQL
  parameterized (ORM or `$-placeholders`) — no string-built queries.
- Payments: gateway signature verification, idempotency keys, ADMIN-only refunds.
- Headers: helmet; CORS allow-list; 64kb body cap; trust-proxy for real IPs.

## 8. Versioning

- API: URL-versioned `/api/v1`; additive changes only inside v1.
- Schema: numbered TypeORM migrations, forward-only in prod (`down` exists
  for dev rescue, never run in prod).
- App: semver in package.json + CHANGELOG.md; every behavior change ships
  with a changelog entry.
