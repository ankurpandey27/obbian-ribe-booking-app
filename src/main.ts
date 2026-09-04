import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ApiEnvelopeDto } from './common/dto/api-envelope.dto';
import { ApiErrorFilter } from './common/filters/api-error.filter';
import { RedisIoAdapter } from './common/realtime/redis-io.adapter';
import { AppLogger } from './common/observability/app-logger';
import { requestContextMiddleware } from './common/observability/request-context.middleware';

/** Default body cap — ride APIs are JSON-only and tiny; blunt DoS guard. */
const JSON_BODY_LIMIT = '64kb';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: false,
  });
  const config = app.get(ConfigService);

  /*
   * Structured logging, installed before anything else runs.
   *
   * `bufferLogs: true` above holds the framework's boot output until a logger is
   * installed, so even module-initialisation failures are emitted in the
   * configured format rather than in a shape the log pipeline cannot parse.
   */
  app.useLogger(
    new AppLogger({
      format:
        config.get<string>('observability.logFormat', 'json') === 'pretty'
          ? 'pretty'
          : 'json',
      level: config.get<string>('observability.logLevel', 'info'),
    }),
  );

  const apiPrefix = config.get<string>('server.apiPrefix', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

  // Behind Render/ALB — required so rate-limiting sees real client IPs.
  app.set('trust proxy', 1);

  /*
   * FIRST middleware: assigns the request id and opens the AsyncLocalStorage
   * context, so every log line downstream carries the same correlation id —
   * including ones from failures that never reach a controller (oversized body,
   * malformed JSON), which are exactly the ones a client needs an id for.
   */
  app.use(requestContextMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: false, // Swagger UI needs inline scripts
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // Capture raw body for webhook HMAC verification (Razorpay signs the raw
  // wire bytes). Must run BEFORE the JSON parser consumes the stream.
  app.use(
    (
      req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        (req as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
        next();
      });
      req.on('error', next);
    },
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

  /**
   * Socket.IO across pods.
   *
   * Must be installed BEFORE listen(), because gateways are instantiated during
   * listen and each one captures the adapter in force at that moment.
   *
   * Without this the default in-memory adapter keeps room membership per
   * process, so a rider connected to pod A never receives a driver location
   * emitted on pod B — live tracking silently stops working the moment a second
   * replica exists.
   */
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connect();
  app.useWebSocketAdapter(ioAdapter);

  // OpenAPI docs — dev/staging convenience, never exposed in production.
  if (config.get<string>('server.env') !== 'production') {
    buildSwagger(app, apiPrefix);
  }

  const port = config.get<number>('server.port', 3000);
  await app.listen(port);
}

/** Builds and mounts Swagger UI (non-production only). */
function buildSwagger(app: NestExpressApplication, apiPrefix: string): void {
  // OpenAPI docs at /api/v1/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Obbian Ride Booking API')
    .setDescription(
      [
        'Modular-monolith ride booking backend — rider & driver flows.',
        '',
        '**Auth:** public endpoints — `auth/*`, `health`, `maps/*`, `rides/quote` and `payments/webhook` — need no token. Everything else requires a Bearer token (JWT). Get one via `POST /auth/send-otp` + `POST /auth/verify-otp` (dev OTP: `123456`), then click **Authorize** and paste the token (without the `Bearer ` prefix — Swagger adds it).',
        '',
        '**Error contract:** every failure returns the unified envelope (`ApiEnvelopeDto`) with `success:false`, `message`, `messageCode`, `data:null`, and `error` ({ code, message }).',
        '',
        '**Fares:** road distance (OSRM), fare = base + km rate + minute rate, floored at minimum, × surge. Quotes are price-locked at request time.',
      ].join('\n'),
    )
    .setVersion('0.8.0')
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
    extraModels: [ApiEnvelopeDto],
  });
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'Obbian Ride Booking API',
  });
}

void bootstrap();
