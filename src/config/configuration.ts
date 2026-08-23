import { registerAs } from '@nestjs/config';

export const serverConfig = registerAs('server', () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  host: process.env.HOST || '0.0.0.0',
}));

// Prefer DATABASE_URL (managed providers like Neon/Render/AWS) and fall back
// to individual DB_* vars for docker-compose / local dev.
export const databaseConfig = registerAs('database', () => {
  const url = process.env.DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      name: parsed.pathname.replace(/^\//, ''),
    };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    name: process.env.DB_NAME || 'ride_booking',
  };
});

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  // managed Redis (Upstash, Redis Cloud) is TLS-only; set REDIS_TLS=true
  tls: (process.env.REDIS_TLS ?? 'false') === 'true',
}));

export const kafkaConfig = registerAs('kafka', () => ({
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  clientId: process.env.KAFKA_CLIENT_ID || 'ride-booking',
  groupId: process.env.KAFKA_GROUP_ID || 'ride-booking-backend',
}));

export const jwtConfig = registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  accessTtl: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
  refreshTtl: parseInt(process.env.JWT_REFRESH_TTL || '2592000', 10),
}));

export const otpConfig = registerAs('otp', () => ({
  provider: process.env.OTP_PROVIDER || 'dev',
  expirySeconds: parseInt(process.env.OTP_EXPIRY_SECONDS || '300', 10),
  maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
  resendCooldownSeconds: parseInt(
    process.env.OTP_RESEND_COOLDOWN_SECONDS || '30',
    10,
  ),
  devCode: process.env.OTP_DEV_CODE || '123456',
  msg91AuthKey: process.env.MSG91_AUTH_KEY,
  msg91SenderId: process.env.MSG91_SENDER_ID,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
}));

export const mapsConfig = registerAs('maps', () => ({
  provider: process.env.MAPS_PROVIDER || 'google',
  googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
  osrmBaseUrl: process.env.OSRM_BASE_URL || 'http://router.project-osrm.org',
}));

export const razorpayConfig = registerAs('razorpay', () => ({
  keyId: process.env.RAZORPAY_KEY_ID,
  keySecret: process.env.RAZORPAY_KEY_SECRET,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  payoutAccount: process.env.RAZORPAY_PAYOUT_ACCOUNT,
}));

export const queueConfig = registerAs('queue', () => ({
  prefix: process.env.BULLMQ_PREFIX || 'ride-booking',
}));

export const matchingConfig = registerAs('matching', () => ({
  radiusKm: parseInt(process.env.MATCHING_RADIUS_KM || '8', 10),
  maxCandidates: parseInt(process.env.MATCHING_MAX_CANDIDATES || '3', 10),
  offerTtlSeconds: parseInt(process.env.MATCHING_OFFER_TTL_SECONDS || '30', 10),
  // true = concurrent offers to all candidates (first accept wins),
  // false = sequential top-1 with a short wait between rejections.
  hedged: (process.env.MATCHING_HEDGED ?? 'true') === 'true',
  sequentialWindowMs: parseInt(
    process.env.MATCHING_SEQUENTIAL_WINDOW_MS || '8000',
    10,
  ),
}));

export const surgeConfig = registerAs('surge', () => ({
  enabled: (process.env.SURGE_ENABLED ?? 'false') === 'true',
  maxMultiplier: parseFloat(process.env.SURGE_MAX_MULTIPLIER || '2.5'),
  windowMinutes: parseInt(process.env.SURGE_WINDOW_MINUTES || '10', 10),
  // demand = ride requests in window; threshold: rides per online driver
  // above which multiplier starts climbing.
  demandThreshold: parseFloat(process.env.SURGE_DEMAND_THRESHOLD || '1.5'),
  multiplierStep: parseFloat(process.env.SURGE_MULTIPLIER_STEP || '0.25'),
  cacheTtlSeconds: parseInt(process.env.SURGE_CACHE_TTL_SECONDS || '60', 10),
}));

export const scheduledRidesConfig = registerAs('scheduledRides', () => ({
  enabled: (process.env.SCHEDULED_RIDES_ENABLED ?? 'true') === 'true',
  maxHoursAhead: parseInt(process.env.SCHEDULED_RIDES_MAX_HOURS || '24', 10),
}));

export const fraudConfig = registerAs('fraud', () => ({
  enabled: (process.env.FRAUD_ENABLED ?? 'true') === 'true',
  maxRidesPerHour: parseInt(process.env.FRAUD_MAX_RIDES_PER_HOUR || '5', 10),
  maxConcurrentActiveRides: parseInt(
    process.env.FRAUD_MAX_CONCURRENT_ACTIVE || '2',
    10,
  ),
  duplicateWindowMinutes: parseInt(
    process.env.FRAUD_DUPLICATE_WINDOW_MINUTES || '10',
    10,
  ),
  maxDuplicateRequests: parseInt(process.env.FRAUD_MAX_DUPLICATES || '3', 10),
}));

export const settlementConfig = registerAs('settlement', () => ({
  enabled: (process.env.SETTLEMENT_ENABLED ?? 'true') === 'true',
  cron: process.env.SETTLEMENT_CRON || '0 3 * * *', // daily 03:00 IST
  commissionPercent: parseFloat(
    process.env.SETTLEMENT_COMMISSION_PERCENT || '20',
  ),
  // Keep settled ride fare histories for N days before purging.
  retentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS || '90', 10),
}));

export const analyticsConfig = registerAs('analytics', () => ({
  enabled: (process.env.ANALYTICS_ENABLED ?? 'true') === 'true',
  defaultDays: parseInt(process.env.ANALYTICS_DEFAULT_DAYS || '30', 10),
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl: parseInt(process.env.THROTTLE_TTL_MS || '60000', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
}));

export const notificationsConfig = registerAs('notifications', () => ({
  fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON,
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  fromEmail: process.env.NOTIFICATIONS_FROM_EMAIL,
}));

export const securityConfig = registerAs('security', () => ({
  // Comma-separated browser origins allowed by CORS. Empty = deny browsers.
  // Mobile apps (Flutter) send no Origin header and are unaffected.
  corsOrigins: process.env.CORS_ORIGINS || '',
}));

export const eventsConfig = registerAs('events', () => ({
  // true = outbox relay publishes to Kafka; false = brokerless mode
  // (outbox rows drain locally — free-tier deploys without Kafka).
  brokerEnabled: (process.env.EVENTS_BROKER_ENABLED ?? 'false') === 'true',
  maxAttempts: parseInt(process.env.EVENTS_MAX_ATTEMPTS || '8', 10),
}));

export const configFactory = [
  serverConfig,
  databaseConfig,
  redisConfig,
  kafkaConfig,
  jwtConfig,
  otpConfig,
  mapsConfig,
  razorpayConfig,
  queueConfig,
  matchingConfig,
  surgeConfig,
  scheduledRidesConfig,
  fraudConfig,
  settlementConfig,
  analyticsConfig,
  throttleConfig,
  notificationsConfig,
  securityConfig,
  eventsConfig,
];
