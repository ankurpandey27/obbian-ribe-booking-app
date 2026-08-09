#!/usr/bin/env node
/**
 * Plain-Node Redis geo seeder — no ts-node/build needed.
 * Hydrates the drivers:geo pool + heartbeats + cached locations from the
 * users/drivers rows created by scripts/seed.sql (or `npm run seed`).
 *
 * Coordinates are deterministic per driver index (same as src/seed.ts),
 * so it is safe to re-run.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
 *   $env:REDIS_HOST="charming-goblin-212518.upstash.io"
 *   $env:REDIS_PORT="6379"
 *   $env:REDIS_PASSWORD="..."
 *   $env:REDIS_TLS="true"
 *   node scripts/seed-redis.mjs
 */
import { Client } from 'pg';
import Redis from 'ioredis';

const DRIVERS_GEO_KEY = 'drivers:geo';

// Mirrors src/seed.ts CITIES order + vehicle types per city, so driver
// index -> city/coordinates match the original seed exactly.
const CITIES = [
  { lat: 28.6139, lon: 77.209, types: ['CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER', 'CABX_SAVER'] },
  { lat: 28.5355, lon: 77.391, types: ['CABX', 'COMFORT', 'AUTO', 'CABX_SAVER'] },
  { lat: 28.4595, lon: 77.0266, types: ['CABX', 'CABXL', 'AUTO'] },
  { lat: 12.9716, lon: 77.5946, types: ['CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER', 'CABX_SAVER'] },
  { lat: 19.076, lon: 72.8777, types: ['CABX', 'COMFORT', 'AUTO', 'CABXL'] },
  { lat: 17.385, lon: 78.4867, types: ['CABX', 'COMFORT', 'AUTO', 'TWO_WHEELER'] },
  { lat: 18.5204, lon: 73.8567, types: ['CABX', 'CABXL', 'AUTO'] },
  { lat: 13.0827, lon: 80.2707, types: ['CABX', 'COMFORT', 'AUTO', 'CABX_SAVER'] },
];

const jitter = (i) => (((i * 37) % 1000) - 500) / 100000;

// phone -> { lat, lon }
const coords = new Map();
let idx = 0;
for (const c of CITIES) {
  for (const _t of c.types) {
    coords.set(`+91${9010000000 + idx}`, {
      lat: c.lat + jitter(idx),
      lon: c.lon + jitter(idx + 7),
    });
    idx += 1;
  }
}
if (idx !== 34) {
  console.error(`expected 34 drivers, got ${idx} — CITIES table out of sync`);
  process.exit(1);
}

const dbUrl =
  process.env.DATABASE_URL ||
  `postgres://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'postgres'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'ride_booking'}`;

const pg = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('sslmode=require') });
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6380),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});

try {
  await pg.connect();
  const { rows } = await pg.query(
    `SELECT u.id, u."phoneNumber" AS phone FROM "users" u JOIN "drivers" d ON d."userId" = u.id`,
  );

  await redis.del(DRIVERS_GEO_KEY);
  const pipe = redis.pipeline();
  let placed = 0;
  for (const r of rows) {
    const c = coords.get(r.phone);
    if (!c) continue;
    pipe.geoadd(DRIVERS_GEO_KEY, c.lon, c.lat, r.id);
    pipe.setex(`driver:${r.id}:heartbeat`, 90, '1');
    pipe.setex(`driver:${r.id}:location`, 300, JSON.stringify({ lat: c.lat, lon: c.lon, timestamp: Date.now() }));
    placed += 1;
  }
  await pipe.exec();

  const inPool = await redis.zcount(DRIVERS_GEO_KEY, '-inf', '+inf');
  console.log(`drivers in DB: ${rows.length} | geo pool: ${inPool} | heartbeats set: ${placed}`);
  if (inPool < rows.length) {
    console.warn(`WARNING: ${rows.length - inPool} driver(s) had no known city mapping and were skipped`);
  }
} finally {
  await redis.quit().catch(() => undefined);
  await pg.end().catch(() => undefined);
}
