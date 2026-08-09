-- ============================================================
-- Obbian ride-booking demo seed (PostgreSQL, idempotent)
-- Mirrors src/seed.ts. Run in the Neon SQL Editor, or:
--   psql "postgresql://..." -f scripts/seed.sql
--
-- After this, hydrate the Redis geo pool (needed for matching):
--   node scripts/seed-redis.mjs
-- ============================================================

-- ------------------------------------------------------------
-- 1. Fare configs — 8 cities x 6 ride types
-- ------------------------------------------------------------
INSERT INTO "fare_configs"
  ("city", "rideType", "baseFare", "perKmRate", "perMinuteRate",
   "minimumFare", "surgeMultiplier", "commissionRate", "isActive")
SELECT c.city, r.ride_type::ride_type,
       ROUND(r.base * c.factor, 2),
       ROUND(r.per_km * c.factor, 2),
       ROUND(r.per_min * c.factor, 2),
       ROUND(r.min_fare * c.factor, 2),
       1.0, 0.25, TRUE
FROM (VALUES
  ('Delhi', 1.00), ('Noida', 0.95), ('Gurugram', 1.00), ('Bangalore', 1.10),
  ('Mumbai', 1.15), ('Hyderabad', 0.90), ('Pune', 0.95), ('Chennai', 0.90)
) AS c(city, factor)
CROSS JOIN (VALUES
  ('TWO_WHEELER', 25, 7, 1, 15),
  ('AUTO', 30, 9, 1, 20),
  ('CABX_SAVER', 60, 12, 1.5, 30),
  ('CABX', 60, 14, 1.5, 40),
  ('CABXL', 90, 18, 2, 60),
  ('COMFORT', 120, 22, 2.5, 80)
) AS r(ride_type, base, per_km, per_min, min_fare)
ON CONFLICT ("city", "rideType") DO NOTHING;

-- ------------------------------------------------------------
-- 2. Users — 16 riders (2 per city) + 34 drivers
-- ------------------------------------------------------------
INSERT INTO "users"
  ("phoneNumber", "role", "firstName", "lastName", "email",
   "rating", "isVerified", "lastLoginAt")
VALUES
  -- riders
  ('+919000000000', 'RIDER', 'Aarav',  'Sharma', 'aarav.sharma@demo.obbian.in',  5.0, TRUE, now()),
  ('+919000000001', 'RIDER', 'Priya',  'Verma',  'priya.verma@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000002', 'RIDER', 'Rahul',  'Gupta',  'rahul.gupta@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000003', 'RIDER', 'Sneha',  'Reddy',  'sneha.reddy@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000004', 'RIDER', 'Vikram', 'Singh',  'vikram.singh@demo.obbian.in',  5.0, TRUE, now()),
  ('+919000000005', 'RIDER', 'Ananya', 'Iyer',   'ananya.iyer@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000006', 'RIDER', 'Karan',  'Mehta',  'karan.mehta@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000007', 'RIDER', 'Divya',  'Nair',   'divya.nair@demo.obbian.in',    5.0, TRUE, now()),
  ('+919000000008', 'RIDER', 'Rohan',  'Kulkarni', 'rohan.kulkarni@demo.obbian.in', 5.0, TRUE, now()),
  ('+919000000009', 'RIDER', 'Ishita', 'Das',    'ishita.das@demo.obbian.in',    5.0, TRUE, now()),
  ('+919000000010', 'RIDER', 'Arjun',  'Bhatt',  'arjun.bhatt@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000011', 'RIDER', 'Meera',  'Joshi',  'meera.joshi@demo.obbian.in',   5.0, TRUE, now()),
  ('+919000000012', 'RIDER', 'Aditya', 'Chopra', 'aditya.chopra@demo.obbian.in', 5.0, TRUE, now()),
  ('+919000000013', 'RIDER', 'Pooja',  'Kaur',   'pooja.kaur@demo.obbian.in',    5.0, TRUE, now()),
  ('+919000000014', 'RIDER', 'Nikhil', 'Rao',    'nikhil.rao@demo.obbian.in',    5.0, TRUE, now()),
  ('+919000000015', 'RIDER', 'Simran', 'Arora',  'simran.arora@demo.obbian.in',  5.0, TRUE, now()),
  -- drivers (no email)
  ('+919010000000', 'DRIVER', 'Rajesh',  'Kumar',    NULL, 5.0, TRUE, NULL),
  ('+919010000001', 'DRIVER', 'Sunil',   'Yadav',    NULL, 5.0, TRUE, NULL),
  ('+919010000002', 'DRIVER', 'Amit',    'Sharma',   NULL, 5.0, TRUE, NULL),
  ('+919010000003', 'DRIVER', 'Manoj',   'Patel',    NULL, 5.0, TRUE, NULL),
  ('+919010000004', 'DRIVER', 'Deepak',  'Mishra',   NULL, 5.0, TRUE, NULL),
  ('+919010000005', 'DRIVER', 'Suresh',  'Gupta',    NULL, 5.0, TRUE, NULL),
  ('+919010000006', 'DRIVER', 'Ravi',    'Verma',    NULL, 5.0, TRUE, NULL),
  ('+919010000007', 'DRIVER', 'Vijay',   'Singh',    NULL, 5.0, TRUE, NULL),
  ('+919010000008', 'DRIVER', 'Pankaj',  'Tiwari',   NULL, 5.0, TRUE, NULL),
  ('+919010000009', 'DRIVER', 'Sanjay',  'Chauhan',  NULL, 5.0, TRUE, NULL),
  ('+919010000010', 'DRIVER', 'Rakesh',  'Bansal',   NULL, 5.0, TRUE, NULL),
  ('+919010000011', 'DRIVER', 'Mukesh',  'Agarwal',  NULL, 5.0, TRUE, NULL),
  ('+919010000012', 'DRIVER', 'Naresh',  'Malik',    NULL, 5.0, TRUE, NULL),
  ('+919010000013', 'DRIVER', 'Dinesh',  'Batra',    NULL, 5.0, TRUE, NULL),
  ('+919010000014', 'DRIVER', 'Gopal',   'Saxena',   NULL, 5.0, TRUE, NULL),
  ('+919010000015', 'DRIVER', 'Harish',  'Thakur',   NULL, 5.0, TRUE, NULL),
  ('+919010000016', 'DRIVER', 'Jitendra','Rawat',    NULL, 5.0, TRUE, NULL),
  ('+919010000017', 'DRIVER', 'Kamal',   'Negi',     NULL, 5.0, TRUE, NULL),
  ('+919010000018', 'DRIVER', 'Lokesh',  'Pradhan',  NULL, 5.0, TRUE, NULL),
  ('+919010000019', 'DRIVER', 'Mahesh',  'Jain',     NULL, 5.0, TRUE, NULL),
  ('+919010000020', 'DRIVER', 'Nitin',   'Bhardwaj', NULL, 5.0, TRUE, NULL),
  ('+919010000021', 'DRIVER', 'Omkar',   'Deshmukh', NULL, 5.0, TRUE, NULL),
  ('+919010000022', 'DRIVER', 'Pradeep', 'Naidu',    NULL, 5.0, TRUE, NULL),
  ('+919010000023', 'DRIVER', 'Ramesh',  'Iyer',     NULL, 5.0, TRUE, NULL),
  ('+919010000024', 'DRIVER', 'Satish',  'Reddy',    NULL, 5.0, TRUE, NULL),
  ('+919010000025', 'DRIVER', 'Tariq',   'Khan',     NULL, 5.0, TRUE, NULL),
  ('+919010000026', 'DRIVER', 'Umesh',   'Pillai',   NULL, 5.0, TRUE, NULL),
  ('+919010000027', 'DRIVER', 'Vinod',   'Menon',    NULL, 5.0, TRUE, NULL),
  ('+919010000028', 'DRIVER', 'Yogesh',  'Dogra',    NULL, 5.0, TRUE, NULL),
  ('+919010000029', 'DRIVER', 'Anil',    'Kohli',    NULL, 5.0, TRUE, NULL),
  ('+919010000030', 'DRIVER', 'Bhupesh', 'Das',      NULL, 5.0, TRUE, NULL),
  ('+919010000031', 'DRIVER', 'Chandan', 'Ghosh',    NULL, 5.0, TRUE, NULL),
  ('+919010000032', 'DRIVER', 'Dheeraj', 'Saha',     NULL, 5.0, TRUE, NULL),
  ('+919010000033', 'DRIVER', 'Faizal',  'Hussain',  NULL, 5.0, TRUE, NULL)
ON CONFLICT ("phoneNumber") DO NOTHING;

-- ------------------------------------------------------------
-- 3. Drivers — ONLINE, linked to the users above (idx 0..33
--    follows src/seed.ts city order: Delhi(6), Noida(4),
--    Gurugram(3), Bangalore(6), Mumbai(4), Hyderabad(4),
--    Pune(3), Chennai(4))
-- ------------------------------------------------------------
WITH d(idx, city, vehicle, model, color, first, last) AS (VALUES
  ( 0,'DEL','CABX',        'Maruti Suzuki Dzire',        'White',  'Rajesh',  'Kumar'),
  ( 1,'DEL','CABXL',       'Toyota Innova Crysta',       'Silver', 'Sunil',   'Yadav'),
  ( 2,'DEL','COMFORT',     'Hyundai Creta',              'Black',  'Amit',    'Sharma'),
  ( 3,'DEL','AUTO',        'Bajaj RE 4S',                'Blue',   'Manoj',   'Patel'),
  ( 4,'DEL','TWO_WHEELER', 'Honda Activa 6G',            'Red',    'Deepak',  'Mishra'),
  ( 5,'DEL','CABX_SAVER',  'Maruti Suzuki WagonR',       'Grey',   'Suresh',  'Gupta'),
  ( 6,'NOI','CABX',        'Maruti Suzuki Dzire',        'White',  'Ravi',    'Verma'),
  ( 7,'NOI','COMFORT',     'Hyundai Creta',              'Silver', 'Vijay',   'Singh'),
  ( 8,'NOI','AUTO',        'Bajaj RE 4S',                'Black',  'Pankaj',  'Tiwari'),
  ( 9,'NOI','CABX_SAVER',  'Maruti Suzuki WagonR',       'Blue',   'Sanjay',  'Chauhan'),
  (10,'GUR','CABX',        'Maruti Suzuki Dzire',        'Red',    'Rakesh',  'Bansal'),
  (11,'GUR','CABXL',       'Toyota Innova Crysta',       'Grey',   'Mukesh',  'Agarwal'),
  (12,'GUR','AUTO',        'Bajaj RE 4S',                'White',  'Naresh',  'Malik'),
  (13,'BAN','CABX',        'Maruti Suzuki Dzire',        'Silver', 'Dinesh',  'Batra'),
  (14,'BAN','CABXL',       'Toyota Innova Crysta',       'Black',  'Gopal',   'Saxena'),
  (15,'BAN','COMFORT',     'Hyundai Creta',              'Blue',   'Harish',  'Thakur'),
  (16,'BAN','AUTO',        'Bajaj RE 4S',                'Red',    'Jitendra','Rawat'),
  (17,'BAN','TWO_WHEELER', 'Honda Activa 6G',            'Grey',   'Kamal',   'Negi'),
  (18,'BAN','CABX_SAVER',  'Maruti Suzuki WagonR',       'White',  'Lokesh',  'Pradhan'),
  (19,'MUM','CABX',        'Maruti Suzuki Dzire',        'Silver', 'Mahesh',  'Jain'),
  (20,'MUM','COMFORT',     'Hyundai Creta',              'Black',  'Nitin',   'Bhardwaj'),
  (21,'MUM','AUTO',        'Bajaj RE 4S',                'Blue',   'Omkar',   'Deshmukh'),
  (22,'MUM','CABXL',       'Toyota Innova Crysta',       'Red',    'Pradeep', 'Naidu'),
  (23,'HYD','CABX',        'Maruti Suzuki Dzire',        'Grey',   'Ramesh',  'Iyer'),
  (24,'HYD','COMFORT',     'Hyundai Creta',              'White',  'Satish',  'Reddy'),
  (25,'HYD','AUTO',        'Bajaj RE 4S',                'Silver', 'Tariq',   'Khan'),
  (26,'HYD','TWO_WHEELER', 'Honda Activa 6G',            'Black',  'Umesh',   'Pillai'),
  (27,'PUN','CABX',        'Maruti Suzuki Dzire',        'Blue',   'Vinod',   'Menon'),
  (28,'PUN','CABXL',       'Toyota Innova Crysta',       'Red',    'Yogesh',  'Dogra'),
  (29,'PUN','AUTO',        'Bajaj RE 4S',                'Grey',   'Anil',    'Kohli'),
  (30,'CHE','CABX',        'Maruti Suzuki Dzire',        'White',  'Bhupesh', 'Das'),
  (31,'CHE','COMFORT',     'Hyundai Creta',              'Silver', 'Chandan', 'Ghosh'),
  (32,'CHE','AUTO',        'Bajaj RE 4S',                'Black',  'Dheeraj', 'Saha'),
  (33,'CHE','CABX_SAVER',  'Maruti Suzuki WagonR',       'Blue',   'Faizal',  'Hussain')
)
INSERT INTO "drivers"
  ("userId", "licenseNumber", "vehicleRegistration", "vehicleModel",
   "vehicleColor", "vehicleType", "status", "rating", "totalRides",
   "completionRate", "acceptanceRate", "walletBalance", "upiId",
   "lastLocationUpdateAt", "onlineSince")
SELECT u.id,
  'DL-' || d.city || '-' || LPAD((d.idx + 1)::text, 3, '0'),
  d.city || '-' || LPAD((d.idx + 1)::text, 2, '0') || '-AB-' || (1000 + d.idx)::text,
  d.model,
  d.color,
  d.vehicle::ride_type,
  'ONLINE'::driver_status,
  ROUND(4.4 + ((d.idx * 7) % 6) / 10.0, 2),
  120 + d.idx * 37,
  98.5,
  96,
  0,
  lower(d.first) || '.' || lower(d.last) || '@okhdfc',
  now(),
  now()
FROM d
JOIN "users" u ON u."phoneNumber" = '+91' || (9010000000 + d.idx)::text
ON CONFLICT ("userId") DO NOTHING;

-- ------------------------------------------------------------
-- 4. Promos
-- ------------------------------------------------------------
INSERT INTO "promos"
  ("code", "discountPercent", "maxDiscount", "maxUsesPerUser",
   "validFrom", "validUntil", "isActive")
VALUES
  ('WELCOME20', 20, 100, 3, now(), now() + interval '365 days', TRUE),
  ('FIRST50',   50, 250, 1, now(), now() + interval '365 days', TRUE),
  ('DEMO10',    10, 50, 10, now(), now() + interval '365 days', TRUE)
ON CONFLICT ("code") DO NOTHING;

-- ------------------------------------------------------------
-- 5. Saved locations — HOME + WORK for the 16 demo riders
-- ------------------------------------------------------------
DELETE FROM "saved_locations" WHERE "userId" IN (
  SELECT id FROM "users" WHERE "phoneNumber" IN (
    SELECT s.phone FROM (VALUES
      ('+919000000000'), ('+919000000001'), ('+919000000002'), ('+919000000003'),
      ('+919000000004'), ('+919000000005'), ('+919000000006'), ('+919000000007'),
      ('+919000000008'), ('+919000000009'), ('+919000000010'), ('+919000000011'),
      ('+919000000012'), ('+919000000013'), ('+919000000014'), ('+919000000015')
    ) AS s(phone)
  )
);

INSERT INTO "saved_locations" ("userId", "label", "lat", "lon", "address")
SELECT u.id, s.label, ROUND(s.lat, 2), ROUND(s.lon, 2), s.address
FROM (VALUES
  ('+919000000000', 'HOME', 28.6259, 77.218,  'Delhi - Home'),
  ('+919000000000', 'WORK', 28.5959, 77.23,   'Delhi - Office'),
  ('+919000000001', 'HOME', 28.6259, 77.218,  'Delhi - Home'),
  ('+919000000001', 'WORK', 28.5959, 77.23,   'Delhi - Office'),
  ('+919000000002', 'HOME', 28.5475, 77.4,    'Noida - Home'),
  ('+919000000002', 'WORK', 28.5175, 77.412,  'Noida - Office'),
  ('+919000000003', 'HOME', 28.5475, 77.4,    'Noida - Home'),
  ('+919000000003', 'WORK', 28.5175, 77.412,  'Noida - Office'),
  ('+919000000004', 'HOME', 28.4715, 77.0356, 'Gurugram - Home'),
  ('+919000000004', 'WORK', 28.4415, 77.0476, 'Gurugram - Office'),
  ('+919000000005', 'HOME', 28.4715, 77.0356, 'Gurugram - Home'),
  ('+919000000005', 'WORK', 28.4415, 77.0476, 'Gurugram - Office'),
  ('+919000000006', 'HOME', 12.9836, 77.6036, 'Bangalore - Home'),
  ('+919000000006', 'WORK', 12.9536, 77.6156, 'Bangalore - Office'),
  ('+919000000007', 'HOME', 12.9836, 77.6036, 'Bangalore - Home'),
  ('+919000000007', 'WORK', 12.9536, 77.6156, 'Bangalore - Office'),
  ('+919000000008', 'HOME', 19.088,  72.8867, 'Mumbai - Home'),
  ('+919000000008', 'WORK', 19.058,  72.8987, 'Mumbai - Office'),
  ('+919000000009', 'HOME', 19.088,  72.8867, 'Mumbai - Home'),
  ('+919000000009', 'WORK', 19.058,  72.8987, 'Mumbai - Office'),
  ('+919000000010', 'HOME', 17.397,  78.4957, 'Hyderabad - Home'),
  ('+919000000010', 'WORK', 17.367,  78.5077, 'Hyderabad - Office'),
  ('+919000000011', 'HOME', 17.397,  78.4957, 'Hyderabad - Home'),
  ('+919000000011', 'WORK', 17.367,  78.5077, 'Hyderabad - Office'),
  ('+919000000012', 'HOME', 18.5324, 73.8657, 'Pune - Home'),
  ('+919000000012', 'WORK', 18.5024, 73.8777, 'Pune - Office'),
  ('+919000000013', 'HOME', 18.5324, 73.8657, 'Pune - Home'),
  ('+919000000013', 'WORK', 18.5024, 73.8777, 'Pune - Office'),
  ('+919000000014', 'HOME', 13.0947, 80.2797, 'Chennai - Home'),
  ('+919000000014', 'WORK', 13.0647, 80.2917, 'Chennai - Office'),
  ('+919000000015', 'HOME', 13.0947, 80.2797, 'Chennai - Home'),
  ('+919000000015', 'WORK', 13.0647, 80.2917, 'Chennai - Office')
) AS s(phone, label, lat, lon, address)
JOIN "users" u ON u."phoneNumber" = s.phone;
