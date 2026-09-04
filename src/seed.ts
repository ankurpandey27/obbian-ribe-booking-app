/**
 * Demo seed — riders, drivers, fare configs, promos and Redis geo pool
 * for 8 cities (Delhi, Noida, Gurugram, Bangalore, Mumbai, Hyderabad,
 * Pune, Chennai) so every API can be demoed end-to-end on Swagger/Postman.
 *
 *   npm run seed             # upsert demo data (idempotent, re-runnable)
 *   npm run seed -- --reset  # delete previous demo data first, then seed
 *
 * Login: POST /auth/send-otp { phone } → POST /auth/verify-otp { phone, otp: "123456" }
 * (dev OTP provider accepts 123456 for every seeded number).
 *
 * Seeded drivers are ONLINE with a Redis geo position, so matching works
 * immediately — request a ride from any city and a driver accepts.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray, eq, sql } from 'drizzle-orm';
import * as schema from './common/database/schema';
import {
  users,
  drivers,
  fareConfigs,
  promos,
  savedLocations,
} from './common/database/schema';
import type { NewFareConfig } from './modules/pricing/entities/fare-config.entity';
import type { NewUser } from './modules/users/entities/user.entity';
import type { NewDriver } from './modules/drivers/entities/driver.entity';
import type { NewSavedLocation } from './modules/users/entities/saved-location.entity';

import { DRIVERS_GEO_KEY } from './common/redis/geo.service';
import { RideTypeValue } from './shared/types/common';

loadEnv();

/* ------------------------------ city data ------------------------------ */

const RIDE_TYPES: RideTypeValue[] = [
  'CABX_SAVER',
  'CABX',
  'CABXL',
  'COMFORT',
  'AUTO',
  'TWO_WHEELER',
];

// [lat, lon, fare factor, driver vehicle types]
const CITIES: {
  name: string;
  lat: number;
  lon: number;
  factor: number;
  drivers: RideTypeValue[];
}[] = [
  {
    name: 'Delhi',
    lat: 28.6139,
    lon: 77.209,
    factor: 1.0,
    drivers: ['CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER', 'CABX_SAVER'],
  },
  {
    name: 'Noida',
    lat: 28.5355,
    lon: 77.391,
    factor: 0.95,
    drivers: ['CABX', 'COMFORT', 'AUTO', 'CABX_SAVER'],
  },
  {
    name: 'Gurugram',
    lat: 28.4595,
    lon: 77.0266,
    factor: 1.0,
    drivers: ['CABX', 'CABXL', 'AUTO'],
  },
  {
    name: 'Bangalore',
    lat: 12.9716,
    lon: 77.5946,
    factor: 1.1,
    drivers: ['CABX', 'CABXL', 'COMFORT', 'AUTO', 'TWO_WHEELER', 'CABX_SAVER'],
  },
  {
    name: 'Mumbai',
    lat: 19.076,
    lon: 72.8777,
    factor: 1.15,
    drivers: ['CABX', 'COMFORT', 'AUTO', 'CABXL'],
  },
  {
    name: 'Hyderabad',
    lat: 17.385,
    lon: 78.4867,
    factor: 0.9,
    drivers: ['CABX', 'COMFORT', 'AUTO', 'TWO_WHEELER'],
  },
  {
    name: 'Pune',
    lat: 18.5204,
    lon: 73.8567,
    factor: 0.95,
    drivers: ['CABX', 'CABXL', 'AUTO'],
  },
  {
    name: 'Chennai',
    lat: 13.0827,
    lon: 80.2707,
    factor: 0.9,
    drivers: ['CABX', 'COMFORT', 'AUTO', 'CABX_SAVER'],
  },
];

// Delhi reference rates (base, perKm, perMin, min) — other cities scaled by factor.
const FARE_REF: Record<RideTypeValue, [number, number, number, number]> = {
  TWO_WHEELER: [25, 7, 1, 15],
  AUTO: [30, 9, 1, 20],
  CABX_SAVER: [60, 12, 1.5, 30],
  CABX: [60, 14, 1.5, 40],
  CABXL: [90, 18, 2, 60],
  COMFORT: [120, 22, 2.5, 80],
};

const RIDER_NAMES = [
  ['Aarav', 'Sharma'],
  ['Priya', 'Verma'],
  ['Rahul', 'Gupta'],
  ['Sneha', 'Reddy'],
  ['Vikram', 'Singh'],
  ['Ananya', 'Iyer'],
  ['Karan', 'Mehta'],
  ['Divya', 'Nair'],
  ['Rohan', 'Kulkarni'],
  ['Ishita', 'Das'],
  ['Arjun', 'Bhatt'],
  ['Meera', 'Joshi'],
  ['Aditya', 'Chopra'],
  ['Pooja', 'Kaur'],
  ['Nikhil', 'Rao'],
  ['Simran', 'Arora'],
];

const DRIVER_NAMES = [
  ['Rajesh', 'Kumar'],
  ['Sunil', 'Yadav'],
  ['Amit', 'Sharma'],
  ['Manoj', 'Patel'],
  ['Deepak', 'Mishra'],
  ['Suresh', 'Gupta'],
  ['Ravi', 'Verma'],
  ['Vijay', 'Singh'],
  ['Pankaj', 'Tiwari'],
  ['Sanjay', 'Chauhan'],
  ['Rakesh', 'Bansal'],
  ['Mukesh', 'Agarwal'],
  ['Naresh', 'Malik'],
  ['Dinesh', 'Batra'],
  ['Gopal', 'Saxena'],
  ['Harish', 'Thakur'],
  ['Jitendra', 'Rawat'],
  ['Kamal', 'Negi'],
  ['Lokesh', 'Pradhan'],
  ['Mahesh', 'Jain'],
  ['Nitin', 'Bhardwaj'],
  ['Omkar', 'Deshmukh'],
  ['Pradeep', 'Naidu'],
  ['Ramesh', 'Iyer'],
  ['Satish', 'Reddy'],
  ['Tariq', 'Khan'],
  ['Umesh', 'Pillai'],
  ['Vinod', 'Menon'],
  ['Yogesh', 'Dogra'],
  ['Anil', 'Kohli'],
  ['Bhupesh', 'Das'],
  ['Chandan', 'Ghosh'],
  ['Dheeraj', 'Saha'],
  ['Faizal', 'Hussain'],
];

const PICKUP_OFFSET = { lat: 0.012, lon: 0.009 }; // pickup ≈ city center + ~1km
const DROPOFF_OFFSET = { lat: -0.018, lon: 0.021 }; // dropoff ≈ city center ~2-3km away

// +91 + 10-digit mobile (IsPhoneNumber('IN') requires exactly this)
const RIDER_PHONE = (i: number) => `+91${9000000000 + i}`;
const DRIVER_PHONE = (i: number) => `+91${9010000000 + i}`;

/* ------------------------------ seed logic ------------------------------ */

const round2 = (n: number) => Math.round(n * 100) / 100;
const jitter = (i: number) => (((i * 37) % 1000) - 500) / 100000;

async function main() {
  const reset = process.argv.includes('--reset');
  const pool: Pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: Number(process.env.DATABASE_PORT ?? 5432),
        user: process.env.DATABASE_USER ?? 'postgres',
        password: process.env.DATABASE_PASSWORD ?? 'postgres',
        database: process.env.DATABASE_NAME ?? 'ride_booking',
      });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const db = drizzle(pool, { schema });
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6380),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: (process.env.REDIS_TLS ?? 'false') === 'true' ? {} : undefined,
  });

  try {
    if (reset) {
      const demoPhones = [
        ...Array.from({ length: 100 }, (_, i) => `+91${9000000000 + i}`),
        ...Array.from({ length: 100 }, (_, i) => `+91${9010000000 + i}`),
        ...Array.from(
          { length: 50 },
          (_, i) => `+9190000${String(i + 1).padStart(4, '0')}`,
        ),
        ...Array.from(
          { length: 50 },
          (_, i) => `+9190001${String(i + 1).padStart(4, '0')}`,
        ),
      ];
      await db.delete(users).where(inArray(users.phoneNumber, demoPhones));
      await db.delete(fareConfigs).where(
        inArray(
          fareConfigs.city,
          CITIES.map((c) => c.name),
        ),
      );
      await db.delete(promos).where(eq(promos.isActive, true));
      console.log(
        '  reset: removed previous demo users, fare configs and promos',
      );
    }

    /* 1. fare configs — every city × every ride type */
    const fares: NewFareConfig[] = [];
    for (const city of CITIES) {
      for (const rideType of RIDE_TYPES) {
        const [base, km, min, minFare] = FARE_REF[rideType];
        const f = city.factor;
        fares.push({
          city: city.name,
          rideType,
          baseFare: round2(base * f),
          perKmRate: round2(km * f),
          perMinuteRate: round2(min * f),
          minimumFare: round2(minFare * f),
          surgeMultiplier: 1.0,
          isActive: true,
        });
      }
    }
    await db
      .insert(fareConfigs)
      .values(fares)
      .onConflictDoUpdate({
        target: [fareConfigs.city, fareConfigs.rideType],
        set: {
          baseFare: sql`excluded.${fareConfigs.baseFare}`,
          perKmRate: sql`excluded.${fareConfigs.perKmRate}`,
          perMinuteRate: sql`excluded.${fareConfigs.perMinuteRate}`,
          minimumFare: sql`excluded.${fareConfigs.minimumFare}`,
          surgeMultiplier: sql`excluded.${fareConfigs.surgeMultiplier}`,
          isActive: sql`excluded.${fareConfigs.isActive}`,
        },
      });

    /* 2. riders — 2 per city */
    const riders: NewUser[] = [];
    let riderIdx = 0;
    for (const _city of CITIES) {
      for (let k = 0; k < 2; k += 1) {
        const [first, last] = RIDER_NAMES[riderIdx];
        riders.push({
          phoneNumber: RIDER_PHONE(riderIdx),
          role: 'RIDER',
          firstName: first,
          lastName: last,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@demo.obbian.in`,
          rating: 5.0,
          isVerified: true,
          lastLoginAt: new Date(),
        });
        riderIdx += 1;
      }
    }
    await db
      .insert(users)
      .values(riders)
      .onConflictDoUpdate({
        target: [users.phoneNumber],
        set: {
          firstName: sql`excluded.${users.firstName}`,
          lastName: sql`excluded.${users.lastName}`,
          email: sql`excluded.${users.email}`,
          rating: sql`excluded.${users.rating}`,
          isVerified: sql`excluded.${users.isVerified}`,
          lastLoginAt: sql`excluded.${users.lastLoginAt}`,
        },
      });

    /* 3. drivers — ONLINE + geo index + heartbeat */
    const driversToInsert: NewDriver[] = [];
    const geo: { userId: string; lon: number; lat: number }[] = [];
    let driverIdx = 0;
    for (const city of CITIES) {
      for (const vehicleType of city.drivers) {
        const [first, last] = DRIVER_NAMES[driverIdx];
        const phone = DRIVER_PHONE(driverIdx);
        const lat = city.lat + jitter(driverIdx);
        const lon = city.lon + jitter(driverIdx + 7);

        await db
          .insert(users)
          .values({
            phoneNumber: phone,
            role: 'DRIVER',
            firstName: first,
            lastName: last,
            rating: 5.0,
            isVerified: true,
          })
          .onConflictDoUpdate({
            target: [users.phoneNumber],
            set: {
              firstName: sql`excluded.${users.firstName}`,
              lastName: sql`excluded.${users.lastName}`,
              rating: sql`excluded.${users.rating}`,
              isVerified: sql`excluded.${users.isVerified}`,
            },
          });
        const driverUser = await db
          .select()
          .from(users)
          .where(eq(users.phoneNumber, phone))
          .limit(1);

        if (driverUser.length > 0) {
          driversToInsert.push({
            userId: driverUser[0].id,
            licenseNumber: `DL-${city.name.slice(0, 3).toUpperCase()}-${String(driverIdx + 1).padStart(3, '0')}`,
            vehicleRegistration: `${city.name.slice(0, 3).toUpperCase()}-${String(driverIdx + 1).padStart(2, '0')}-AB-${String(1000 + driverIdx)}`,
            vehicleModel: VEHICLE_MODELS[vehicleType],
            vehicleColor: COLORS[driverIdx % COLORS.length],
            vehicleType,
            status: 'ONLINE',
            rating: round2(4.4 + ((driverIdx * 7) % 6) / 10),
            totalRides: 120 + driverIdx * 37,
            completionRate: 98.5,
            acceptanceRate: 96,
            walletBalance: 0,
            upiId: `${first.toLowerCase()}.${last.toLowerCase()}@okhdfc`,
            lastLocationUpdateAt: new Date(),
            onlineSince: new Date(),
          });
          geo.push({ userId: driverUser[0].id, lon, lat });
        }
        driverIdx += 1;
      }
    }
    await db
      .insert(drivers)
      .values(driversToInsert)
      .onConflictDoUpdate({
        target: [drivers.userId],
        set: {
          licenseNumber: sql`excluded.${drivers.licenseNumber}`,
          vehicleRegistration: sql`excluded.${drivers.vehicleRegistration}`,
          vehicleModel: sql`excluded.${drivers.vehicleModel}`,
          vehicleColor: sql`excluded.${drivers.vehicleColor}`,
          vehicleType: sql`excluded.${drivers.vehicleType}`,
          status: sql`excluded.${drivers.status}`,
          rating: sql`excluded.${drivers.rating}`,
          totalRides: sql`excluded.${drivers.totalRides}`,
          completionRate: sql`excluded.${drivers.completionRate}`,
          acceptanceRate: sql`excluded.${drivers.acceptanceRate}`,
          walletBalance: sql`excluded.${drivers.walletBalance}`,
          upiId: sql`excluded.${drivers.upiId}`,
          lastLocationUpdateAt: sql`excluded.${drivers.lastLocationUpdateAt}`,
          onlineSince: sql`excluded.${drivers.onlineSince}`,
        },
      });

    /* 4. Redis — geo pool + heartbeat + cached location per driver */
    for (const { userId, lon, lat } of geo) {
      await redis.geoadd(DRIVERS_GEO_KEY, lon, lat, userId);
      await redis.setex(`driver:${userId}:heartbeat`, 90, '1');
      await redis.setex(
        `driver:${userId}:location`,
        300,
        JSON.stringify({ lat, lon, timestamp: Date.now() }),
      );
    }

    /* 5. promos */
    const now = new Date();
    const yearFromNow = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
    await db
      .insert(promos)
      .values([
        {
          code: 'WELCOME20',
          discountPercent: 20,
          maxDiscount: 100,
          maxUsesPerUser: 3,
          validFrom: now,
          validUntil: yearFromNow,
          isActive: true,
        },
        {
          code: 'FIRST50',
          discountPercent: 50,
          maxDiscount: 250,
          maxUsesPerUser: 1,
          validFrom: now,
          validUntil: yearFromNow,
          isActive: true,
        },
        {
          code: 'DEMO10',
          discountPercent: 10,
          maxDiscount: 50,
          maxUsesPerUser: 10,
          validFrom: now,
          validUntil: yearFromNow,
          isActive: true,
        },
      ])
      .onConflictDoUpdate({
        target: [promos.code],
        set: {
          discountPercent: sql`excluded.${promos.discountPercent}`,
          maxDiscount: sql`excluded.${promos.maxDiscount}`,
          maxUsesPerUser: sql`excluded.${promos.maxUsesPerUser}`,
          validFrom: sql`excluded.${promos.validFrom}`,
          validUntil: sql`excluded.${promos.validUntil}`,
          isActive: sql`excluded.${promos.isActive}`,
        },
      });

    /* 6. saved locations — HOME + WORK per demo rider */
    const riderPhonesAll = Array.from({ length: 16 }, (_, i) => RIDER_PHONE(i));
    const demoRiders = await db
      .select()
      .from(users)
      .where(inArray(users.phoneNumber, riderPhonesAll))
      .orderBy(users.createdAt);
    await db.delete(savedLocations).where(
      inArray(
        savedLocations.userId,
        demoRiders.map((u) => u.id),
      ),
    );
    const saved: NewSavedLocation[] = [];
    for (const [idx, u] of demoRiders.entries()) {
      const city = CITIES[Math.floor(idx / 2) % CITIES.length];
      saved.push(
        {
          userId: u.id,
          label: 'HOME',
          lat: round2(city.lat + PICKUP_OFFSET.lat),
          lon: round2(city.lon + PICKUP_OFFSET.lon),
          address: `${city.name} — Home`,
        },
        {
          userId: u.id,
          label: 'WORK',
          lat: round2(city.lat + DROPOFF_OFFSET.lat),
          lon: round2(city.lon + DROPOFF_OFFSET.lon),
          address: `${city.name} — Office`,
        },
      );
    }
    if (saved.length > 0) {
      await db.insert(savedLocations).values(saved);
    }

    console.log(
      `\nSeed complete: ${fares.length} fare configs, ${riders.length} riders, ${driversToInsert.length} drivers (ONLINE + geo pool), 3 promos, ${saved.length} saved locations.`,
    );
    console.log(
      'Demo login: POST /auth/send-otp { phone } → POST /auth/verify-otp { phone, otp: "123456" } — riders +91 90000000xx, drivers +91 90100000xx.',
    );
  } finally {
    await redis.quit();
    await pool.end();
  }
}

const VEHICLE_MODELS: Record<RideTypeValue, string> = {
  CABX_SAVER: 'Maruti Suzuki WagonR',
  CABX: 'Maruti Suzuki Dzire',
  CABXL: 'Toyota Innova Crysta',
  COMFORT: 'Hyundai Creta',
  AUTO: 'Bajaj RE 4S',
  TWO_WHEELER: 'Honda Activa 6G',
};

const COLORS = ['White', 'Silver', 'Black', 'Blue', 'Red', 'Grey'];

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
