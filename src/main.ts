import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { ApiErrorDto } from './common/dto/api-error';
import { ApiErrorFilter } from './common/filters/api-error.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  const apiPrefix = config.get<string>('server.apiPrefix', 'api/v1');
  app.setGlobalPrefix(apiPrefix);

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

  app.enableCors({ origin: true, credentials: true });
  app.enableShutdownHooks();

  // OpenAPI docs at /api/v1/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Obbian Ride Booking API')
    .setDescription(
      [
        'Modular-monolith ride booking backend — rider & driver flows.',
        '',
        '**Auth:** all endpoints except `auth/*`, `maps/*` and the Razorpay webhook require a Bearer token (JWT). Get one via `POST /auth/send-otp` + `POST /auth/verify-otp` (dev OTP: `123456`), then click **Authorize** and paste the token (without the `Bearer ` prefix — Swagger adds it).',
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
