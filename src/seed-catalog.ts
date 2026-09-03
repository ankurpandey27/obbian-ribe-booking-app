/**
 * Catalog seed — idempotent upsert of services, ride categories, city
 * availability, and catalog version. Driven by the catalog tables (Drizzle),
 * not the TypeORM seed. Re-runnable safely.
 *
 *   ts-node src/seed-catalog.ts
 *
 * Seeds the 17 ride categories from the product doc, scoped to Hyderabad,
 * with en-IN/hi-IN/te-IN localized copy. The 6 legacy ride types keep their
 * codes so existing fare configs and rides remain valid.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './common/database/schema';

loadEnv();

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5433/ride_booking',
});
const db = drizzle(pool, { schema });

// ── 17 ride categories from the product doc ──────────────────────────────
// Legacy codes (CABX_SAVER, CABX, CABXL, COMFORT, AUTO, TWO_WHEELER) are
// preserved so existing fare configs and rides keep working.
const CATEGORIES = [
  {
    code: 'BIKE',
    caps: 'Bike',
    capacity: 1,
    flags: { twoWheeler: true },
    vehicleClass: 'TWO_WHEELER',
  },
  {
    code: 'BIKE_LITE',
    caps: 'Bike Lite',
    capacity: 1,
    flags: { twoWheeler: true },
    vehicleClass: 'TWO_WHEELER',
  },
  {
    code: 'SCOOTY',
    caps: 'Scooty',
    capacity: 1,
    flags: { twoWheeler: true, womenOnly: false },
    vehicleClass: 'TWO_WHEELER',
  },
  {
    code: 'SHE_BIKE',
    caps: 'She-Bike',
    capacity: 1,
    flags: { twoWheeler: true, womenOnly: true },
    vehicleClass: 'TWO_WHEELER',
  },
  {
    code: 'SHE_SHARE',
    caps: 'She-Share',
    capacity: 2,
    flags: { sharedRide: true, womenOnly: true },
    vehicleClass: 'CAB',
  },
  { code: 'AUTO', caps: 'Auto', capacity: 3, flags: {}, vehicleClass: 'AUTO' },
  {
    code: 'AUTO_LITE',
    caps: 'Auto Lite',
    capacity: 3,
    flags: {},
    vehicleClass: 'AUTO',
  },
  {
    code: 'AUTO_QUICK',
    caps: 'Auto Quick',
    capacity: 3,
    flags: { quick: true },
    vehicleClass: 'AUTO',
  },
  {
    code: 'AUTO_CORPORATE_POOLING',
    caps: 'Auto Corporate Pooling',
    capacity: 4,
    flags: { sharedRide: true, corporate: true },
    vehicleClass: 'AUTO',
  },
  {
    code: 'CABX_SAVER',
    caps: 'Cab AC',
    capacity: 4,
    flags: {},
    vehicleClass: 'CAB',
  }, // legacy
  {
    code: 'CABX',
    caps: 'Cab AC Quick',
    capacity: 4,
    flags: { quick: true },
    vehicleClass: 'CAB',
  }, // legacy
  {
    code: 'CABXL',
    caps: 'Cab Non-AC',
    capacity: 4,
    flags: {},
    vehicleClass: 'CAB',
  }, // legacy
  {
    code: 'COMFORT',
    caps: 'Cab AC Extra Large',
    capacity: 6,
    flags: { xl: true },
    vehicleClass: 'CAB',
  }, // legacy
  {
    code: 'CAB_CORPORATE_POOLING',
    caps: 'Cab Corporate Pooling',
    capacity: 4,
    flags: { sharedRide: true, corporate: true },
    vehicleClass: 'CAB',
  },
  {
    code: 'RENTAL_CABS',
    caps: 'Rental Cabs',
    capacity: 4,
    flags: { rental: true },
    vehicleClass: 'CAB',
  },
  {
    code: 'OUTSTATION',
    caps: 'Cab Outstation',
    capacity: 4,
    flags: { outstation: true },
    vehicleClass: 'CAB',
  },
  {
    code: 'AIRPORT_TAXI',
    caps: 'Airport Taxi',
    capacity: 4,
    flags: { airport: true },
    vehicleClass: 'CAB',
  },
];

// Localized names per category code
const NAMES: Record<string, Record<string, string>> = {
  BIKE: { 'en-IN': 'Bike', 'hi-IN': 'बाइक', 'te-IN': 'బైక్' },
  BIKE_LITE: {
    'en-IN': 'Bike Lite',
    'hi-IN': 'बाइक लाइट',
    'te-IN': 'బైక్ లైట్',
  },
  SCOOTY: { 'en-IN': 'Scooty', 'hi-IN': 'स्कूटी', 'te-IN': 'స్కూటీ' },
  SHE_BIKE: { 'en-IN': 'She-Bike', 'hi-IN': 'शी-बाइक', 'te-IN': 'షీ-బైక్' },
  SHE_SHARE: { 'en-IN': 'She-Share', 'hi-IN': 'शी-शेयर', 'te-IN': 'షీ-షేర్' },
  AUTO: { 'en-IN': 'Auto', 'hi-IN': 'ऑटो', 'te-IN': 'ఆటో' },
  AUTO_LITE: { 'en-IN': 'Auto Lite', 'hi-IN': 'ऑटो लाइट', 'te-IN': 'ఆటో లైట్' },
  AUTO_QUICK: {
    'en-IN': 'Auto Quick',
    'hi-IN': 'ऑटो क्विक',
    'te-IN': 'ఆటో క్విక్',
  },
  AUTO_CORPORATE_POOLING: {
    'en-IN': 'Auto Corporate Pooling',
    'hi-IN': 'ऑटो कॉर्पोरेट पूलिंग',
    'te-IN': 'ఆటో కార్పొరేట్ పూలింగ్',
  },
  CABX_SAVER: { 'en-IN': 'Cab AC', 'hi-IN': 'कैब एसी', 'te-IN': 'క్యాబ్ ఎసీ' },
  CABX: {
    'en-IN': 'Cab AC Quick',
    'hi-IN': 'कैब एसी क्विक',
    'te-IN': 'క్యాబ్ ఎసీ క్విక్',
  },
  CABXL: {
    'en-IN': 'Cab Non-AC',
    'hi-IN': 'कैब नॉन-एसी',
    'te-IN': 'క్యాబ్ నాన్-ఎసీ',
  },
  COMFORT: {
    'en-IN': 'Cab AC Extra Large',
    'hi-IN': 'कैब एसी एक्स्ट्रा लार्ज',
    'te-IN': 'క్యాబ్ ఎసీ ఎక్స్ట్రా లార్జ్',
  },
  CAB_CORPORATE_POOLING: {
    'en-IN': 'Cab Corporate Pooling',
    'hi-IN': 'कैब कॉर्पोरेट पूलिंग',
    'te-IN': 'క్యాబ్ కార్పొరేట్ పూలింగ్',
  },
  RENTAL_CABS: {
    'en-IN': 'Rental Cabs',
    'hi-IN': 'रेंटल कैब्स',
    'te-IN': 'రెంటల్ క్యాబ్స్',
  },
  OUTSTATION: {
    'en-IN': 'Cab Outstation',
    'hi-IN': 'कैब आउटस्टेशन',
    'te-IN': 'క్యాబ్ అవుట్‌స్టేషన్',
  },
  AIRPORT_TAXI: {
    'en-IN': 'Airport Taxi',
    'hi-IN': 'एयरपोर्ट टैक्सी',
    'te-IN': 'ఎయిర్పోర్ట్ టాక్సీ',
  },
};

const DESCRIPTIONS: Record<string, Record<string, string>> = {
  SHE_SHARE: {
    'en-IN': 'Shared rides for women, by women',
    'hi-IN': 'महिलाओं के लिए साझा राइड, महिलाओं द्वारा',
    'te-IN': 'మహిళలకు షేర్డ్ రైడ్‌లు, మహిళలచే',
  },
  SHE_BIKE: {
    'en-IN': 'Women-only bike rides',
    'hi-IN': 'केवल महिलाओं के लिए बाइक राइड',
    'te-IN': 'మహిళలకు మాత్రమే బైక్ రైడ్‌లు',
  },
};

async function seed() {
  console.log('Seeding catalog...');

  // Service: RIDE
  const [existingService] = await db
    .select()
    .from(schema.services)
    .where(eq(schema.services.code, 'RIDE'))
    .limit(1);

  let serviceId = existingService?.id;
  if (!serviceId) {
    const [row] = await db
      .insert(schema.services)
      .values({
        code: 'RIDE',
        displayName: { 'en-IN': 'Ride', 'hi-IN': 'सवारी', 'te-IN': 'రైడ్' },
        iconUrl: null,
        sortOrder: 0,
        isActive: true,
      })
      .returning();
    serviceId = row.id;
    console.log('  created service RIDE');
  } else {
    console.log('  service RIDE already exists');
  }

  // Categories
  for (const cat of CATEGORIES) {
    const [existing] = await db
      .select()
      .from(schema.rideCategories)
      .where(eq(schema.rideCategories.code, cat.code))
      .limit(1);

    let categoryId = existing?.id;
    if (!categoryId) {
      const [row] = await db
        .insert(schema.rideCategories)
        .values({
          code: cat.code,
          serviceId,
          displayName: NAMES[cat.code] ?? { 'en-IN': cat.caps },
          description: DESCRIPTIONS[cat.code] ?? {},
          iconUrl: null,
          thumbnailUrl: null,
          capacity: cat.capacity,
          sortOrder: CATEGORIES.indexOf(cat),
          isActive: true,
          flags: cat.flags,
          vehicleClass: cat.vehicleClass,
          etaFactor: 1.0,
        })
        .returning();
      categoryId = row.id;
      console.log(`  created category ${cat.code}`);
    } else {
      console.log(`  category ${cat.code} already exists`);
    }

    // City availability for Hyderabad
    const [existingCity] = await db
      .select()
      .from(schema.rideCategoryCities)
      .where(
        and(
          eq(schema.rideCategoryCities.rideCategoryId, categoryId),
          eq(schema.rideCategoryCities.city, 'Hyderabad'),
        ),
      )
      .limit(1);

    if (!existingCity) {
      await db.insert(schema.rideCategoryCities).values({
        rideCategoryId: categoryId,
        city: 'Hyderabad',
        isAvailable: true,
        sortOrder: CATEGORIES.indexOf(cat),
      });
      console.log(`  added Hyderabad availability for ${cat.code}`);
    }
  }

  // Initialize catalog version
  await db
    .insert(schema.catalogVersions)
    .values({ scope: 'global', version: 1 })
    .onConflictDoNothing({ target: schema.catalogVersions.scope });

  console.log('Catalog seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Catalog seed failed:', err);
  process.exit(1);
});
