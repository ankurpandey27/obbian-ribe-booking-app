import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ApiErrorDto } from './common/dto/api-error';
import { ApiErrorFilter } from './common/filters/api-error.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

/** Default body cap — ride APIs are JSON-only and tiny; blunt DoS guard. */
const JSON_BODY_LIMIT = '64kb';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: false,
  });
  const config = app.get(ConfigService);

  const apiPrefix = config.get<string>('server.apiPrefix', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  // Behind Render/ALB — required so rate-limiting sees real client IPs.
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: false, // Swagger UI needs inline scripts
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  // Unified API contract enforcement
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new ApiErrorFilter());

  // CORS: explicit allow-list. Comma-separated origins in CORS_ORIGINS;
  // unset → same-origin/API clients only (mobile apps send no Origin).
  const corsOrigins = config
    .get<string>('security.corsOrigins', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    maxAge: 86400,
  });
  app.enableShutdownHooks();

  // OpenAPI docs at /api/v1/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Obbian Ride Booking API')
    .setDescription(
      [
        'Modular-monolith ride booking backend — rider & driver flows.',
        '',
        '**Auth:** public endpoints — `auth/*`, `health`, `maps/*`, `rides/quote` and `payments/webhook` — need no token. Everything else requires a Bearer token (JWT). Get one via `POST /auth/send-otp` + `POST /auth/verify-otp` (dev OTP: `123456`), then click **Authorize** and paste the token (without the `Bearer ` prefix — Swagger adds it).',
        '',
        '**Error contract:** every failure returns `ApiErrorDto` with `statusCode`, `message`, `error`, `timestamp`, `path`, `requestId`.',
        '',
        '**Fares:** road distance (OSRM), fare = base + km rate + minute rate, floored at minimum, × surge. Quotes are price-locked at request time.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addTag('auth', 'OTP login, token refresh, logout')
    .addTag('users', 'Rider profile & saved locations')
    .addTag('drivers', 'Driver onboarding, status, live location, ride actions')
    .addTag('maps', 'Public map helpers: autocomplete, geocode, route')
    .addTag('pricing', 'Fare quotes (public read paths)')
    .addTag('rides', 'Request, schedule, track, cancel & rate rides')
    .addTag('promos', 'Promo code validation')
    .addTag('payments', 'Razorpay payments, receipts, refunds')
    .addTag('tracking', 'REST fallback for live ride tracking')
    .addTag('ratings', 'Aggregate user ratings')
    .addTag('analytics', 'Ops dashboard aggregates')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig, {
    extraModels: [ApiErrorDto],
  });
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'Obbian Ride Booking API',
  });

  const port = config.get<number>('server.port', 3000);
  await app.listen(port);
  console.log(
    `🚕 Ride backend listening on http://localhost:${port}/${apiPrefix}`,
  );
}
void bootstrap();
