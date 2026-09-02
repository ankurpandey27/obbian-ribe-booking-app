/**
 * Drizzle schema — single import surface for all runtime data access.
 *
 * Tables are grouped into one file per DOMAIN (AGENTS.md §5: a table belongs
 * to exactly one future service). Import from this barrel, never from the
 * domain files directly, so the extraction boundary can move without a
 * repo-wide import rewrite.
 *
 *   core       → users, auth, drivers, rides, payments, pricing, outbox, safety
 *   finance    → wallet ledger, settlements, fare breakdown, GST invoices
 *   compliance → driver documents, driver vehicles
 *   trips      → ride stops, route breadcrumbs, reviews
 *   ops        → incidents, cancellation penalties, webhook dedupe, admin audit
 *   engagement → devices, notifications
 *   growth     → referrals, driver incentives
 *   geo        → geofenced areas, surge history
 *
 * Column names are camelCase string literals mirroring the hand-written
 * migrations in src/migrations. NEVER bulk-edit these files with regex — an
 * empty column name compiles but breaks at runtime (guarded by schema.spec.ts).
 */

// NOTE: './enums' is deliberately NOT re-exported. The object passed to
// drizzle() must contain tables/relations only — leaking enum value arrays or
// plain constants into it pollutes relational query inference. Import enums
// from './schema/enums' (inside the schema layer) or use the framework-free
// value types in src/shared/types/common.ts (outside it).
export * from './core';
export * from './finance';
export * from './compliance';
export * from './trips';
export * from './ops';
export * from './engagement';
export * from './growth';
export * from './geo';
