# Runbook — Partitioning `rides` and `payments`

**Status:** planned, not yet executed
**Owner:** platform / DBA
**Risk:** HIGH — full table rewrite under `ACCESS EXCLUSIVE`
**Referenced by:** `src/migrations/010-partitioning-and-indexes.ts`

---

## Why this is a runbook and not a migration

`DatabaseModule` runs migrations at application boot (`migrationsRun: true`).
Converting a populated table into a partitioned parent requires either a full
rewrite or a rename-and-copy, both of which hold `ACCESS EXCLUSIVE` for the
duration. On a live `rides` table that is minutes of total unavailability —
every read and write blocks, including health checks, so the orchestrator will
kill the pod mid-rewrite and leave the schema half-migrated.

Migration 010 therefore ships only the index work for these two tables (which
is the actual near-term bottleneck) and partitions just the two new empty
telemetry tables. This document covers the rest, to be run deliberately by an
operator during a maintenance window.

Do not convert this runbook into a boot migration.

---

## When to run it

Trigger on whichever comes first:

- `rides` exceeds ~50M rows, or
- the monthly `rides` growth rate exceeds ~5M rows/month, or
- retention deletes (`DELETE FROM rides WHERE createdAt < …`) start causing
  vacuum pressure or replication lag.

Below those thresholds the composite indexes from migration 010 are sufficient
and partitioning is premature.

---

## Pre-flight

1. Confirm a tested restore path exists. Take a fresh base backup and *verify
   it restores* before touching anything.
2. Confirm current size and row counts:
   ```sql
   SELECT relname,
          pg_size_pretty(pg_total_relation_size(relid)) AS total,
          n_live_tup
     FROM pg_stat_user_tables
    WHERE relname IN ('rides','payments');
   ```
3. Confirm the oldest row, which determines the first partition bound:
   ```sql
   SELECT min("createdAt") FROM rides;
   SELECT min("createdAt") FROM payments;
   ```
4. Announce the window. Put the API into maintenance mode (drain traffic at the
   load balancer) — this is not an online operation.
5. Stop the workers and the scheduler so nothing writes mid-cutover:
   BullMQ consumers, `OutboxRelayWorker`, `SettlementService` cron,
   `PartitionMaintenanceService` cron.

---

## Procedure — `rides`

Partition key: `createdAt`, monthly range.

`rides` is referenced by foreign keys from `payments`, `ride_stops`,
`ride_reviews`, `incidents`, `cancellation_penalties`, `invoices`,
`referral_redemptions` and `scheduled_rides`. A partitioned table cannot be the
target of a foreign key in PostgreSQL 16, so **those FKs must be dropped** and
the equivalent integrity enforced in the application layer (it already is —
every write path resolves the ride through `RidesService.getRide()` first).
Record this consciously; it is the real cost of partitioning this table.

```sql
BEGIN;

-- 1. New partitioned parent, identical column list.
CREATE TABLE rides_new (LIKE rides INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
  PARTITION BY RANGE ("createdAt");

-- Partitioned PK must include the partition key.
ALTER TABLE rides_new ADD PRIMARY KEY (id, "createdAt");

-- 2. Create partitions covering min(createdAt) .. +2 months.
--    ensure_time_partition() ships in migration 010.
DO $$
DECLARE m date;
BEGIN
  FOR m IN
    SELECT generate_series(
             date_trunc('month', (SELECT min("createdAt") FROM rides)),
             date_trunc('month', now() + interval '2 months'),
             interval '1 month'
           )::date
  LOOP
    PERFORM ensure_time_partition('rides_new', m::timestamptz, 'month');
  END LOOP;
END $$;

-- 3. Copy. Expect roughly 1–2 minutes per 10M rows on provisioned IOPS.
INSERT INTO rides_new SELECT * FROM rides;

-- 4. Verify BEFORE swapping. Abort if these do not match.
--    (Do not skip: a short count is unrecoverable after the drop.)
SELECT
  (SELECT count(*) FROM rides)     AS old_rows,
  (SELECT count(*) FROM rides_new) AS new_rows,
  (SELECT sum("totalFare") FROM rides)     AS old_fare,
  (SELECT sum("totalFare") FROM rides_new) AS new_fare;

-- 5. Drop dependent FKs (see note above), then swap.
ALTER TABLE payments               DROP CONSTRAINT IF EXISTS "payments_rideId_fkey";
ALTER TABLE ride_stops             DROP CONSTRAINT IF EXISTS "ride_stops_rideId_fkey";
ALTER TABLE ride_reviews           DROP CONSTRAINT IF EXISTS "ride_reviews_rideId_fkey";
ALTER TABLE incidents              DROP CONSTRAINT IF EXISTS "incidents_rideId_fkey";
ALTER TABLE cancellation_penalties DROP CONSTRAINT IF EXISTS "cancellation_penalties_rideId_fkey";
ALTER TABLE invoices               DROP CONSTRAINT IF EXISTS "invoices_rideId_fkey";
ALTER TABLE referral_redemptions   DROP CONSTRAINT IF EXISTS "referral_redemptions_qualifyingRideId_fkey";
ALTER TABLE scheduled_rides        DROP CONSTRAINT IF EXISTS "scheduled_rides_rideId_fkey";

ALTER TABLE rides     RENAME TO rides_old;
ALTER TABLE rides_new RENAME TO rides;

-- 6. Recreate the indexes from migration 010 on the new parent.
CREATE INDEX "IDX_rides_riderId"               ON rides ("riderId");
CREATE INDEX "IDX_rides_driverId"              ON rides ("driverId");
CREATE INDEX "IDX_rides_status"                ON rides ("status");
CREATE INDEX "IDX_rides_rideType"              ON rides ("rideType");
CREATE INDEX "IDX_rides_rider_status_created"  ON rides ("riderId", "status", "createdAt" DESC);
CREATE INDEX "IDX_rides_city_status_created"   ON rides ("city", "status", "createdAt" DESC);
CREATE INDEX "IDX_rides_driver_active"         ON rides ("driverId", "status")
  WHERE "status" IN ('ACCEPTED','ARRIVED','IN_PROGRESS');
CREATE INDEX "IDX_rides_settlement_sweep"      ON rides ("driverId", "completedAt")
  WHERE "status" = 'COMPLETED';
CREATE INDEX "IDX_rides_matching_queue"        ON rides ("city", "createdAt")
  WHERE "status" = 'REQUESTED';

COMMIT;
```

Then, outside the transaction:

```sql
ANALYZE rides;
```

Keep `rides_old` for at least one full backup cycle. Drop it only after the
application has run clean through a peak period:

```sql
DROP TABLE rides_old;
```

## Procedure — `payments`

Identical shape, partition key `createdAt`, monthly. `payments` is referenced by
nothing, so there are no FKs to drop — it is the safer of the two and a good
rehearsal for the `rides` cutover. Do `payments` first.

---

## Post-cutover

1. Re-point `PartitionMaintenanceService` to include the new parents so future
   partitions are created ahead of time. Without this, the first insert past the
   last partition bound fails.
2. Confirm partition routing:
   ```sql
   SELECT tableoid::regclass, count(*) FROM rides GROUP BY 1 ORDER BY 1;
   ```
3. Confirm partition pruning is happening on the hot queries — the plan should
   touch one or two children, not all of them:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT * FROM rides
    WHERE "riderId" = '00000000-0000-0000-0000-000000000000'
      AND "createdAt" > now() - interval '30 days'
    ORDER BY "createdAt" DESC LIMIT 20;
   ```
4. Re-enable workers, scheduler and traffic.
5. Watch error rates and p99 latency for one full peak cycle before dropping
   the `_old` tables.

---

## Rollback

Before `DROP TABLE rides_old`, rollback is a rename swap:

```sql
BEGIN;
ALTER TABLE rides     RENAME TO rides_failed;
ALTER TABLE rides_old RENAME TO rides;
COMMIT;
ANALYZE rides;
```

Writes that landed after the cutover live in `rides_failed` and must be
reconciled by hand — which is why the window must be drained, not merely quiet.

After `rides_old` is dropped there is no rollback other than a restore from
backup. Do not drop it on the same day as the cutover.

---

## Index rebuild note

Migration 010 uses plain `CREATE INDEX`, because `CREATE INDEX CONCURRENTLY`
cannot run inside TypeORM's migration transaction. If 010 is ever applied to a
large populated table, the index build will lock writes. In that case: let 010
create them, then rebuild concurrently during a low-traffic window:

```sql
DROP INDEX CONCURRENTLY "IDX_rides_rider_status_created";
CREATE INDEX CONCURRENTLY "IDX_rides_rider_status_created"
  ON rides ("riderId", "status", "createdAt" DESC);
```
