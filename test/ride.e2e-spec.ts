import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Full ride lifecycle e2e against real infra (docker: Postgres/Redis/Kafka).
 * Boots the whole AppModule in-process; BullMQ matching worker runs
 * inside the same process, so accept works via the REST driver routes.
 *
 * Requires: docker containers up, .env loaded (jest-e2e inherits process
 * env; ensure .env values match your local compose ports).
 */
describe('Ride lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  const stamp = Date.now() % 10000000000;
  const riderPhone = `+9191${String(stamp).padStart(10, '0')}`;
  const driverPhone = `+9188${String(stamp).padStart(10, '0')}`;

  const PICKUP = { lat: 28.7041, lon: 77.1025 };
  const DROPOFF = { lat: 28.5355, lon: 77.391 };

  let riderToken = '';
  let driverToken = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const sendOtp = async (phone: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/send-otp')
      .send({ phone })
      .expect(200);

  const verifyOtp = async (phone: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/verify-otp')
      .send({ phone, otp: '123456' })
      .expect(200);

  describe('auth', () => {
    it('sends + verifies OTP and returns JWT + refresh token', async () => {
      await sendOtp(riderPhone);
      const res = await verifyOtp(riderPhone);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      riderToken = res.body.accessToken;
    });

    it('rejects a wrong OTP with 400', async () => {
      await sendOtp(driverPhone);
      const res = await verifyOtp(driverPhone);
      expect(res.body.accessToken).toBeDefined();
      driverToken = res.body.accessToken;
      await sendOtp(riderPhone);
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-otp')
        .send({ phone: riderPhone, otp: '000000' })
        .expect(400);
    });
  });

  describe('driver onboarding', () => {
    it('registers a driver profile and picks up DRIVER role after re-login', async () => {
      const reg = await request(app.getHttpServer())
        .post('/api/v1/drivers/register')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          licenseNumber: `DL-04-${stamp}`,
          vehicleRegistration: `DL-01-${stamp}`,
          vehicleModel: 'Maruti Suzuki Dzire',
          vehicleColor: 'White',
          vehicleType: 'CABX',
          upiId: 'driver@upi',
        });
      expect(reg.status).toBe(201);
      expect(reg.body.status).toBe('OFFLINE');

      await sendOtp(driverPhone);
      const re = await verifyOtp(driverPhone);
      driverToken = re.body.accessToken;

      await request(app.getHttpServer())
        .put('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'ONLINE' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/drivers/location')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ lat: PICKUP.lat, lon: PICKUP.lon, timestamp: Date.now() })
        .expect(201);
    });
  });

  describe('quote', () => {
    it('returns CABX fare for the route (OSRM road distance)', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/v1/rides/quote?pickupLat=${PICKUP.lat}&pickupLon=${PICKUP.lon}&dropoffLat=${DROPOFF.lat}&dropoffLon=${DROPOFF.lon}&city=Delhi`,
        )
        .set('Authorization', `Bearer ${riderToken}`)
        .expect(200);
      expect(res.body.options).toBeDefined();
      const cabx = res.body.options.find(
        (o: { rideType: string }) => o.rideType === 'CABX',
      );
      expect(cabx).toBeDefined();
      expect(cabx.fare).toBeGreaterThan(0);
    });
  });

  describe('ride lifecycle', () => {
    let rideId = '';

    it('requests a ride and gets matched by the online driver', async () => {
      const req = await request(app.getHttpServer())
        .post('/api/v1/rides/request')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({
          pickupLat: PICKUP.lat,
          pickupLon: PICKUP.lon,
          dropoffLat: DROPOFF.lat,
          dropoffLon: DROPOFF.lon,
          rideType: 'CABX',
          city: 'Delhi',
        })
        .expect(201);
      rideId = req.body.rideId;
      expect(req.body.estimatedFare).toBeGreaterThan(0);

      // Worker dispatch is async — the offer lands in Redis within ~1s.
      await new Promise((r) => setTimeout(r, 1500));

      const accept = await request(app.getHttpServer())
        .post('/api/v1/drivers/accept-ride')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ rideId })
        .expect(200);
      expect(accept.body.accepted).toBe(true);

      const ride = await request(app.getHttpServer())
        .get(`/api/v1/rides/${rideId}`)
        .set('Authorization', `Bearer ${riderToken}`)
        .expect(200);
      expect(ride.body.status).toBe('ACCEPTED');
      expect(ride.body.driverId).toBeDefined();
    }, 30000);

    it('runs arrived → start → complete', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/drivers/rides/${rideId}/arrived`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/drivers/rides/${rideId}/start`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);
      const done = await request(app.getHttpServer())
        .post(`/api/v1/drivers/rides/${rideId}/complete`)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.totalFare).toBeGreaterThan(0);
    }, 30000);

    it('appears in rider history and can be rated', async () => {
      const hist = await request(app.getHttpServer())
        .get('/api/v1/rides/history?limit=5')
        .set('Authorization', `Bearer ${riderToken}`)
        .expect(200);
      expect(
        hist.body.rides.some((r: { rideId: string }) => r.rideId === rideId),
      ).toBe(true);

      await request(app.getHttpServer())
        .post(`/api/v1/rides/${rideId}/rate`)
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ rating: 5, asRider: true })
        .expect(201);
    }, 30000);
  });

  describe('no-driver fallback', () => {
    it('cancels with NO_DRIVER_FOUND instead of hanging', async () => {
      await sendOtp(driverPhone);
      const re = await verifyOtp(driverPhone);
      driverToken = re.body.accessToken;
      await request(app.getHttpServer())
        .put('/api/v1/drivers/status')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ status: 'OFFLINE' })
        .expect(200);

      const req = await request(app.getHttpServer())
        .post('/api/v1/rides/request')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({
          pickupLat: PICKUP.lat,
          pickupLon: PICKUP.lon,
          dropoffLat: DROPOFF.lat,
          dropoffLon: DROPOFF.lon,
          rideType: 'CABX',
          city: 'Delhi',
        })
        .expect(201);

      let status = 'REQUESTED';
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const ride = await request(app.getHttpServer())
          .get(`/api/v1/rides/${req.body.rideId}`)
          .set('Authorization', `Bearer ${riderToken}`)
          .expect(200);
        status = ride.body.status;
        if (status !== 'REQUESTED' && status !== 'MATCHING') break;
      }
      expect(status).toBe('CANCELLED');
    }, 60000);
  });
});
