# Architecture Decision Records

Immutable log of significant architectural decisions. Append-only; a
decision is changed by writing a new ADR that supersedes it.

---

## ADR-001: Modular monolith first, microservices on trigger

**Status:** Accepted · **Date:** 2026-08

**Context:** Small backend team, 3–4 month runway to 5M users. Microservices
from day one would spend the runway on infra instead of product.

**Decision:** One deployable NestJS app with real module boundaries
(`src/modules/*`). Each module owns its tables and exposes services via
module `exports`. Cross-module writes of state go through events (outbox).
The six-service split (gateway/user/trip/matching/tracking/payment) happens
on load triggers, not before.

**Consequences:** Fast iteration now; extraction is cut-paste + transport
swap because boundaries were enforced from day one. Requires review discipline
against boundary violations.

---

## ADR-002: ORM strategy — Drizzle (migration complete)

**Status:** Accepted · Implemented v0.4–v0.6 · **Date:** 2026-08

**Context:** MVP shipped on TypeORM (NestJS default ecosystem). R&D verdict:
TypeORM is in maintenance decline (−8% YoY, stalled releases, weak relation
typing), while Drizzle hit v1.0 (+340% YoY, SQL-transparent, fully typed).

**Decision:** ALL runtime data access goes through Drizzle
(`DrizzleModule` → `DRIZZLE_DB`), migrated module-by-module in three waves:
pricing/promos/users/drivers → rides/fraud/scheduled/auth/tracking/outbox →
payments/settlement/ratings/analytics/notifications.

**Residual TypeORM surface (intentional):**
1. `DatabaseModule` boots migrations via `migrationsRun: true`.
2. `typeorm.config.ts` CLI datasource for generating/running migrations.
3. Legacy `*.entity.ts` classes remain as **type-only contracts** — rows are
   structurally identical; a final sweep can replace them with
   `typeof table.$inferSelect` exports from `common/database/schema`.

**Consequences:** Hot paths get SQL-transparent typed queries with near-zero
runtime overhead. Atomic ride transitions preserved via
`UPDATE … WHERE status=:from RETURNING *`. Numeric columns use
`mode: 'number'` to match prior entity types.

---

## ADR-003: Transactional outbox over direct broker publish

**Status:** Accepted · **Date:** 2026-08

**Context:** Ride facts published directly to Kafka could be lost when the
broker was down (errors were swallowed) — unacceptable for settlement/
analytics correctness.

**Decision:** Ride lifecycle events are written to `outbox_events` inside the
same transaction as the state change; `OutboxRelayWorker` drains rows with
`FOR UPDATE SKIP LOCKED` (multi-instance safe) at-least-once. Matching
signals remain best-effort by design. Brokerless mode drains without sending.

**Consequences:** Consumers must be idempotent; event delivery latency gains
a relay interval (~5s); Postgres stores the durable log (auditable replay).

---

## ADR-004: Geospatial strategy

**Status:** Accepted · **Date:** 2026-08

**Decision:** Redis GEO (geohash zset) is the live matching index;
heartbeat TTL keys gate freshness at match time (no cron). H3 hex cells are
the planned granularity for surge/demand aggregation (ADR pending
implementation), mirroring Uber/Rapido. City-sharded geo keys are the next
Redis scaling step.

**Why not H3-for-matching now:** GEORADIUS is Redis-native, O(log n) and
correct at our scale; an in-process H3 index adds operational complexity
before ~200K concurrent captains. Revisit per ARCHITECTURE §6 triggers.

---

## ADR-005: Money correctness rules

**Status:** Accepted · **Date:** 2026-08

1. Quotes are price-locked into the ride row at request time (surge included);
   completion recomputes only from road distance × locked config − promo.
2. Promo redemption is atomic (Redis INCR + compensation on failure).
3. Payment mutations require idempotency keys; webhook processing dedupes on
   gateway event id; refunds are ADMIN-only.
4. Fare math stays in decimal columns; integer-paise migration is part of the
   wallet ledger workstream (pre-double-entry-ledger stopgap documented here).

---

## ADR-00X: Roju agent surface, SOS intake, and webhook bridge

**Context.** The Roju voice/chat agent needs booking authority without a second
implementation of pricing/fraud/state-machine logic, plus a way to receive
ride lifecycle events and raise SOS.

**Decision.** A thin `/agent/rides/*` surface delegating to the SAME domain
services as native endpoints (fraud guard, price lock, conditional transitions
all hold). Quote state lives server-side behind short-lived quote ids so
execute re-validates the exact confirmed fare. Execute is idempotent by key.
SOS intake is a first-class module writing durable `safety_events` + outbox
event. Lifecycle delivery to the agent is an outbound HMAC-signed webhook
worker (at-least-once via cursor+overlap; agent dedupes on eventId).

**Consequences.** One source of truth for money/matching rules; the agent
stays a presentation/orchestration layer. Webhook delivery adds one polling
worker; Kafka consumers remain the future scaling path unchanged.

---

## ADR-006: Ledger as an independent module

**Status:** Accepted · **Date:** 2026-08

**Context:** Ride completion credits the driver while payment settlement debits
the same wallet. Keeping the ledger inside Payments created a Rides↔Payments
cycle and made the ledger boundary dishonest.

**Decision:** `LedgerModule` owns `WalletLedgerService` and reconciliation.
Rides and Payments import the module instead of using `forwardRef()` or reaching
into one another's tables.

**Consequences:** The ledger can become its own service without moving payment
rules with it. Completion and settlement pass their open transaction to the
ledger when the money movement is part of a larger state change.

---

## ADR-007: Fare breakdown and surge arithmetic

**Status:** Accepted · **Date:** 2026-08

**Context:** Recomputing extras or tax in multiple layers caused differences
between the rider charge, invoice, and ledger.

**Decision:** Apply the minimum fare before surge. Only base, distance, and time
are multiplied by surge; toll, tip, night, waiting, and extra stops are not.
Commission excludes tip. The fare breakdown stores `taxPaise = 0`; the invoice
owns the tax split.

**Consequences:** Each component has one owner and multi-stop completion can be
audited from the persisted breakdown.

---

## ADR-008: Gap-free GST invoice issuance

**Status:** Accepted · **Date:** 2026-08

**Context:** PostgreSQL sequences do not roll back. A failed invoice transaction
would burn a number and create a false gap.

**Decision:** Lock an `invoice_sequences` row inside the issuing transaction,
increment it, and insert the invoice with that number. `splitExactTax` divides
already-extracted tax using floor plus remainder. An unmapped city falls back to
the seller state and emits a warning rather than over-collecting IGST.

**Consequences:** Number issuance and invoice insertion commit together, and
the audit identifies real missing rows.

---

## ADR-009: Durable webhook and outbox recovery

**Status:** Accepted · **Date:** 2026-08

**Context:** Provider retries and consumer outages are normal. A separately
committed webhook claim can mark a payment handled while its update rolls back.

**Decision:** Webhook dedupe is INSERT-first on `UNIQUE(source,eventId)` inside
the caller's transaction. DLQ retry resets attempts to zero and is bounded by
configuration. Published outbox rows may be purged after retention; FAILED rows
are never purged automatically.

**Consequences:** Failed handlers remain retryable without double-applying a
payment, and unresolved data loss remains visible.

---

## ADR-010: Private, pull-based observability

**Status:** Accepted · **Date:** 2026-08

**Context:** Metrics on the public API would expose route inventory and queue
depths if ingress were misconfigured.

**Decision:** Own a per-process registry with bounded labels and expose it on an
unauthenticated dedicated `METRICS_PORT`. Live gauges read their source at
scrape time under a deadline. Request context uses AsyncLocalStorage and inbound
request ids are sanitized before logging.

**Consequences:** Monitoring remains available while the API is saturated, but
the metrics port must remain on the private monitoring network.

---

## ADR-011: Partition only high-volume telemetry tables

**Status:** Accepted · **Date:** 2026-08

**Context:** Route points and surge history grow continuously, while converting
populated rides or payments during `migrationsRun` would take an ACCESS
EXCLUSIVE lock and kill pods.

**Decision:** Partition only `ride_route_points` by day and
`surge_zones_history` by month. A scheduled worker pre-creates future ranges and
drops aged ranges under a PostgreSQL advisory lock. Rides and payments remain
on the operator runbook.

**Consequences:** Retention is an instant partition drop and future inserts have
a range available without a migration-time rewrite.

---

## ADR-012: Append-only wallet ledger and drift reporting

**Status:** Accepted · **Date:** 2026-08

**Context:** A cached driver balance without an immutable explanation cannot
survive retries, disputes, or reconciliation.

**Decision:** Every balance mutation is an append-only paise ledger entry with
an idempotency key, row lock, balance-before/after checks, and an atomic cache
update. Drift is reported and emitted as an event; it is never auto-repaired.

**Consequences:** Entries are auditable and retry-safe. Repair is an explicit
admin action that preserves the incident trail.

---

## ADR-013: Compliance is a dispatch gate

**Status:** Accepted · **Date:** 2026-08

**Context:** A driver can lose a licence, insurance, or vehicle eligibility
while still marked online.

**Decision:** Drivers cannot go ONLINE unless required documents for the active
vehicle are verified and unexpired. The expiry sweep revokes eligibility and
matching performs the same gate.

**Consequences:** Supply can drop when documents lapse, but dispatch never sends
a ride to an ineligible driver.

---

## ADR-014: Completion is one financial transaction

**Status:** Accepted · **Date:** 2026-08

**Context:** A completed ride without its fare breakdown, GST invoice, or driver
earning is financially unreconcilable.

**Decision:** Completion commits the conditional state transition, outbox event,
fare breakdown, invoice, ledger earning/commission, and growth progress in one
transaction. A retry returns an already completed ride without re-crediting.

**Consequences:** A transient failure leaves the ride incomplete and retryable
instead of creating a partial financial record.

---

## ADR-015: Redis claims with one wake-up channel

**Status:** Accepted · **Date:** 2026-08

**Context:** Polling every claim wastes Redis capacity and delays an accepted
ride. Per-ride channels add subscription churn, and pub/sub is not durable.

**Decision:** `SET NX EX` remains authoritative. All rides share `ride:claims`,
with ride id in the payload. Waiters register before the initial GET and always
perform a final GET. ACCEPTED wakes all waiters; DECLINED wakes only the
driver-bound waiter. The Socket.IO adapter uses duplicated Redis clients and
falls back to in-memory mode if Redis is unavailable.

**Consequences:** Message loss costs latency rather than correctness. A Redis
outage cannot grant a claim, while geo lookups and rate limits may degrade open.
