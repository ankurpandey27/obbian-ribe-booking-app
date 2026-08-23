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

## ADR-002: ORM strategy — TypeORM today, Drizzle as target

**Status:** Accepted (migration scheduled) · **Date:** 2026-08

**Context:** MVP shipped on TypeORM (NestJS default ecosystem). R&D verdict:
TypeORM is in maintenance decline (−8% YoY, stalled releases, weak relation
typing), while Drizzle hit v1.0 (+340% YoY, SQL-transparent, fully typed).

**Decision:** Keep TypeORM for the running base in v0.x to avoid a big-bang
rewrite while hardening security. Migrate module-by-module to Drizzle as the
next dedicated workstream, starting with read-heavy modules. New extracted
microservices are born on Drizzle.

**Consequences:** Short-term ORM duplication risk is contained because all
data access lives behind service methods — controllers never touch repositories.
Migration must preserve the atomic transition semantics
(conditional UPDATE … RETURNING).

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
