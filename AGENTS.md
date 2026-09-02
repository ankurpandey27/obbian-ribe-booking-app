# AGENTS.md — Engineering Rules for AI Coding Agents

> **Read this file before writing any code in this repository.**
> These rules are enforced by code review. Violations = rejected PR.
> Stack: NestJS 10 · TypeScript · PostgreSQL (+PostGIS) · Drizzle ORM ·
> Redis · BullMQ · Kafka (optional) · Node 18+. Target: 5M users.

---

## 0. Prime directives

1. **This is a BASE, not an MVP.** Every feature you add must survive 5M
   users and a team of 10 engineers. No shortcuts "for now".
2. **Match existing patterns before inventing new ones.** Look at how the
   nearest sibling module does it; copy its structure exactly.
3. **Every behavior change ships with:** throwaway verification, a
   `CHANGELOG.md` entry, and — if architectural — an ADR in `docs/adr/ADR.md`.
4. **When unsure, stop and ask.** Never guess money logic, auth logic,
   or state-machine transitions.

---

## 1. NestJS structure rules

### Controllers — THIN ADAPTERS ONLY
```
✅ Controller: parse HTTP → call ONE service method → map to response shape
❌ Controller: NO business logic, NO multi-service orchestration chains,
   NO direct repository/DB access, NO fare/promo/state calculations
```
- Max ~15 lines per handler body. If more → extract a service use-case method.
- One controller per resource per module (`rides.controller`, not `rides-v2.controller`).
- Always decorate: `@ApiOperation`, typed `@Api…Response` with real DTOs,
  `@ApiBadRequestResponse({ type: ApiErrorDto })`.
- Use `@CurrentUser()` for identity; never read `req.user` raw.

### Services — business logic owner
- One service = one aggregate's rules. Cross-module reads go through the
  other module's exported service (via `imports:`), never its repository.
- Orchestration use-cases (e.g. ride request = fraud + quote + promo +
  create) live in ONE service method named after the verb
  (`RidesService.requestRide()`).
- Constructor injection only; string-token deps need `@Inject(TOKEN)`.

### Modules
- Feature modules live in `src/modules/<domain>/`; global infra in
  `src/common/*`. Nothing else.
- A module exports ONLY what other modules need (services + guards).
- Module boundaries are microservice seams — see §5 before crossing one.
- Never import another module's `.entity`/schema internals; use its
  exported services.

### DTOs & validation
- Every request body/query has a DTO with class-validator decorators.
- Global pipe already enforces `whitelist + forbidNonWhitelisted` — do NOT
  strip those. Add explicit validators for every new field.
- Responses are shaped objects (never raw entities) so DB columns can evolve
  without breaking clients.

---

## 2. Data layer rules (Drizzle)

- ALL runtime data access uses Drizzle via `DRIZZLE_DB`
  (`common/database/drizzle.module.ts`). Do NOT add TypeORM repositories —
  TypeORM exists only to run migrations.
- Schema source of truth: `src/common/database/schema/index.ts`.
  Column names are camelCase strings matching the hand-written migrations.
  **Never bulk-edit schema files with regex** — column names live as string
  literals and empty names pass compile but break runtime
   (verified by the repository's throwaway schema checks).
- Numeric money columns: `numeric(..., { mode: 'number' })`. Compute money in
  integers (paise) where possible; never float arithmetic on money.
- Migrations are HAND-WRITTEN TS files in `src/migrations/NNN-*.ts`
  (up AND down). New index → new migration + matching `@Index`/schema entry.
  Never edit an applied migration.
- **Every new query pattern on rides/payments needs its composite index**
  shipped in the same PR. Rule of thumb: anything filtering by
  `(ownerId, status)` must have `(ownerId, status, createdAt DESC)`.
- Transactions: state change + its outbox event go in ONE
  `db.transaction()`. See `RidesService.transition()` for the canonical
  pattern (conditional `UPDATE … WHERE status=:from` + conflict check).

---

## 3. Eventing rules

- Durable facts (ride lifecycle, payment results) MUST be written through
  the **transactional outbox** (`OutboxService.write(tx, evt)`) — never
  published directly to Kafka from a request path.
- Ephemeral signals (matching offers/responses) may use
  `EventBus.publish()` best-effort.
- Consumers must be idempotent on event id. Producers set
  `aggregateType` + `aggregateId` (= partition key).
- Brokerless mode exists (`EVENTS_BROKER_ENABLED=false`) — code must work
  with the relay draining without Kafka.

---

## 4. Concurrency & correctness rules

- Any state transition on a shared row uses the conditional-update pattern:
  ```ts
  const [updated] = await tx.update(rides)
    .set({ status: to })
    .where(and(eq(rides.id, id), eq(rides.status, from)))
    .returning();
  if (!updated) throw new ConflictException(...);
  ```
- Claim tokens across competing workers: Redis `SET key val NX EX ttl`
  (see matching claim). First writer wins; losers get an explicit
  not-accepted result.
- Anything that must expire does so via Redis TTL (heartbeats, offers,
  OTPs) — no cron-based cleanup for freshness.
- Compensation over 2-phase: if step N fails after claiming a resource
  (e.g. promo INCR), release it in a catch block (see promo redeem/release).

---

## 5. Microservice-readiness rules

Modules map 1:1 to future services
(auth+users+drivers → user-svc · rides → trip-svc · matching · tracking ·
payments+wallets). When touching code near a boundary:

1. **No cross-module service imports for writes** — state changes cross
   boundaries only via events (outbox).
2. Reads may call another module's exported service today; note it in the
   extraction comment.
3. Schema tables grouped by domain in `schema/index.ts` — a table belongs to
   exactly one future service.
4. `common/` holds zero business logic; it graduates to `@app/shared`.
5. Never reach into another module's DB tables directly.

Do NOT introduce actual message brokers/HTTP between modules yet — the
event-publisher seam is the swap point later.

---

## 6. Security rules (non-negotiable)

- New endpoints default to AUTHENTICATED. Public access requires an explicit
  `@Public()` + justification in the PR description.
- Any route scoped by a resource id gets an ownership guard
  (pattern: `RideParticipantGuard`). "Authenticated" ≠ "authorized".
- Role-restricted ops use `@Roles('ADMIN'|'DRIVER')` — payments refunds are
  ADMIN-only; do not weaken.
- All SQL parameterized (ORM APIs). String-concatenated SQL = instant reject.
- Secrets come from env only. Production boot fails without
  `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`. Never log tokens, OTPs, or
  payment payloads.
- Brute-forceable surfaces (OTP send/verify, refresh) carry strict
  `@Throttle` limits — preserve them on any new auth-like endpoint.
- Swagger/docs mount only outside production.
- Webhooks verify signatures server-side before trusting payload.
- Fraud guards exist for a reason: new ride-like creation flows must call
  `FraudService.guardRideRequest()` or justify skipping it.

---

## 7. Performance & scalability rules

- Hot-path rule: rider/driver polls must hit indexes — check `EXPLAIN` for
  any query on a table >10k rows in your head before shipping.
- GPS/location writes NEVER go to Postgres synchronously — Redis geo + TTL
  cache only; persistence happens sampled/batched off the hot path.
- Independent awaits fan out with `Promise.all`; sequential awaits on the
  request path need a comment proving dependency.
- Side effects that don't affect the response (notifications, demand
  counters, driver restore) are fire-and-forget with `.catch(log)`.
- Response payloads stay lean: list endpoints paginate (limit ≤ 100),
  no unbounded `find()` without take.
- Per-cell/per-city sharding keys are preferred over global keys for new
  Redis counters (surge precedent).

---

## 8. Error handling & API contract

- Every failure returns the unified envelope: `statusCode, message, error,
  timestamp, path, requestId` (via `ApiErrorFilter`). Throw Nest built-ins
  (`NotFoundException`, `ConflictException`, `ForbiddenException`,
  `BadRequestException`); the filter shapes them.
- Status codes: 400 validation · 401 auth · 403 ownership/role ·
  404 missing · 409 concurrent-state conflict · 429 throttled · 503
  upstream provider down.
- Never leak stack traces, SQL, or internal ids of OTHER users in messages.
- Fire-and-forget ops log failures with context (`rideId`, `userId`) — silent
  catches are rejects unless documented like promo `release()`.

---

## 9. Verification rules

- Do not create or retain `*.spec.ts` or `*.test.ts` files. Verify behavior with
  temporary scripts under `test/`, then delete those scripts before finishing.
- Any bug fix is verified against the reported failure before the fix is kept.
- New guards/decorators are verified structurally by a throwaway script.
- `npm run build && npm test && npm run lint` must pass before every push.
  Lint has zero-error policy (one accepted warning in drizzle.module).
- For journey-level changes (matching, payments), run the live e2e flow
  against staging and paste evidence in the PR.

---

## 10. Documentation & versioning rules

- Semver via `VERSION`; user-visible changes → `CHANGELOG.md` under a new
  heading (Added/Changed/Security/Fixed).
- Architectural decisions → append-only ADR in `docs/adr/ADR.md`
  (Context/Decision/Consequences). Supersede, never edit history.
- Public API changes: additive inside `/api/v1`; breaking → `/api/v2` plan.
- Docstrings explain WHY, not WHAT. JSDoc on every exported service method.

---

## 11. Feature checklist (run before opening a PR)

- [ ] Thin controller, logic in service, one use-case method
- [ ] DTO validated (whitelist respected), response shaped (no raw entity)
- [ ] Ownership/role guard where resources are addressed by id
- [ ] Indexes added for new query patterns (migration + schema)
- [ ] Events via outbox if durable; consumer idempotency considered
- [ ] Race conditions considered (conditional update / NX claim)
- [ ] Money handled safely (paise-safe math, idempotent ops)
- [ ] Tests added/updated, all green; lint clean
- [ ] CHANGELOG entry; ADR if architecture shifted
- [ ] Works in brokerless mode and with TTL-less local Redis

---

*These rules were distilled from the security/correctness/scalability review
rounds recorded in CHANGELOG v0.2.0–v0.6.2 and docs/adr/ADR.md. Propose rule
changes via a new ADR, not by editing this file silently.*
