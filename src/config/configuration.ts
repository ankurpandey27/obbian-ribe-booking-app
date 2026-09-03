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

export const jwtConfig = registerAs('jwt', () => {
  const accessSecret = process.env.JWT_ACCESS_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;
  const env = process.env.NODE_ENV || 'development';
  // Fail fast rather than run production on known defaults.
  if (env === 'production' && (!accessSecret || !refreshSecret)) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are REQUIRED in production',
    );
  }
  return {
    accessSecret: accessSecret || 'dev-access-secret',
    refreshSecret: refreshSecret || 'dev-refresh-secret',
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL || '900', 10),
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL || '2592000', 10),
  };
});

export const otpConfig = registerAs('otp', () => {
  const provider = process.env.OTP_PROVIDER || 'dev';
  const devCode = process.env.OTP_DEV_CODE || '123456';
  const env = process.env.NODE_ENV || 'development';
  // Fail fast rather than run production on a universal OTP. A misconfigured
  // deploy that leaves provider=dev lets ANY user log in with code 123456.
  if (env === 'production' && (provider === 'dev' || devCode === '123456')) {
    throw new Error(
      'OTP_PROVIDER must be a real provider (msg91/twilio) and OTP_DEV_CODE must not be the default in production',
    );
  }
  return {
    provider,
    expirySeconds: parseInt(process.env.OTP_EXPIRY_SECONDS || '300', 10),
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
    resendCooldownSeconds: parseInt(
      process.env.OTP_RESEND_COOLDOWN_SECONDS || '30',
      10,
    ),
    devCode,
    msg91AuthKey: process.env.MSG91_AUTH_KEY,
    msg91SenderId: process.env.MSG91_SENDER_ID,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
  };
});

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
  // Rows that exhausted maxAttempts land in the DLQ (status=FAILED). Ops can
  // list/retry them via the admin surface; this caps how many a single retry
  // request may re-queue so an accidental click cannot stampede the relay.
  dlqRetryBatchLimit: parseInt(process.env.EVENTS_DLQ_RETRY_LIMIT || '50', 10),
}));

/**
 * Wallet ledger (migration 005). The ledger is the financial source of truth;
 * `drivers.walletBalancePaise` is a cache. `reconcileCron` re-derives every
 * driver's balance by replaying entries and alerts on any drift.
 */
export const ledgerConfig = registerAs('ledger', () => ({
  // Nightly reconciliation: SUM(wallet_ledger.amountPaise) vs the cached
  // balance, per driver. Drift is a P1 — it means a write path bypassed the
  // ledger.
  reconcileEnabled: (process.env.LEDGER_RECONCILE_ENABLED ?? 'true') === 'true',
  reconcileCron: process.env.LEDGER_RECONCILE_CRON || '0 4 * * *',
  // Drivers scanned per reconciliation batch — keeps the job off long locks.
  reconcileBatchSize: parseInt(
    process.env.LEDGER_RECONCILE_BATCH_SIZE || '500',
    10,
  ),
  // Ops correction ceiling. A MANUAL_ADJUSTMENT above this needs a second
  // approver rather than a single admin's word.
  maxManualAdjustmentPaise: parseInt(
    process.env.LEDGER_MAX_MANUAL_ADJUSTMENT_PAISE || '5000000', // ₹50,000
    10,
  ),
}));

/**
 * GST invoicing (migration 005). India mandates a taxable invoice per ride.
 * Ride fares are quoted TAX-INCLUSIVE, so the invoice works backwards from the
 * gross via extractInclusiveTax().
 */
export const invoiceConfig = registerAs('invoice', () => {
  const enabled = (process.env.INVOICE_ENABLED ?? 'true') === 'true';
  const sellerGstin = process.env.INVOICE_SELLER_GSTIN;
  const sellerLegalName = process.env.INVOICE_SELLER_LEGAL_NAME;
  const env = process.env.NODE_ENV || 'development';

  // An invoice issued without the seller's GSTIN and legal name is not a valid
  // tax document. Failing at boot is far cheaper than discovering a financial
  // year of unusable invoices during an audit.
  if (env === 'production' && enabled && (!sellerGstin || !sellerLegalName)) {
    throw new Error(
      'INVOICE_SELLER_GSTIN and INVOICE_SELLER_LEGAL_NAME are REQUIRED in ' +
        'production when INVOICE_ENABLED=true (GST invoices are legally ' +
        'invalid without them). Set INVOICE_ENABLED=false only if a separate ' +
        'system issues invoices.',
    );
  }

  return {
    enabled,
    // 5% is the GST rate for passenger road transport without ITC.
    gstRatePercent: parseFloat(process.env.INVOICE_GST_RATE_PERCENT || '5'),
    // 996422 = passenger transport by road.
    sacCode: process.env.INVOICE_SAC_CODE || '996422',
    // Invoice number format: {series}/{FY}/{000001}
    series: process.env.INVOICE_SERIES || 'OBN',
    sellerGstin,
    sellerLegalName,
    // Home state of the seller. A ride whose place of supply differs is
    // inter-state and gets IGST instead of CGST+SGST.
    sellerStateCode: process.env.INVOICE_SELLER_STATE_CODE || 'TS',
  };
});

/**
 * Driver compliance gate (migration 006). A driver may not go ONLINE unless
 * every REQUIRED_DRIVER_DOCUMENTS slot is VERIFIED and unexpired.
 */
export const complianceConfig = registerAs('compliance', () => {
  const enforceForDispatch =
    (process.env.COMPLIANCE_ENFORCE_DISPATCH ?? 'true') === 'true';
  const env = process.env.NODE_ENV || 'development';

  // Dispatching a driver with unverified or lapsed DL / RC / insurance is a
  // regulatory violation, not a tunable. The switch exists so local seeding
  // does not need a document workflow — it may not be off in production.
  if (env === 'production' && !enforceForDispatch) {
    throw new Error(
      'COMPLIANCE_ENFORCE_DISPATCH=false is not permitted in production: ' +
        'dispatching drivers without verified DL/RC/insurance is a regulatory ' +
        'violation.',
    );
  }

  return {
    enforceForDispatch,
    // Nightly sweep flips VERIFIED→EXPIRED past expiresAt and clears the
    // driver's isComplianceVerified flag.
    expirySweepEnabled:
      (process.env.COMPLIANCE_EXPIRY_SWEEP_ENABLED ?? 'true') === 'true',
    expirySweepCron: process.env.COMPLIANCE_EXPIRY_SWEEP_CRON || '30 2 * * *',
    // Warn the driver this many days before a document lapses so they can
    // renew before losing dispatch eligibility.
    expiryWarningDays: parseInt(
      process.env.COMPLIANCE_EXPIRY_WARNING_DAYS || '15',
      10,
    ),
    // Presigned upload URL lifetime.
    uploadUrlTtlSeconds: parseInt(
      process.env.COMPLIANCE_UPLOAD_URL_TTL_SECONDS || '900',
      10,
    ),
    maxDocumentBytes: parseInt(
      process.env.COMPLIANCE_MAX_DOCUMENT_BYTES || '5242880', // 5 MiB
      10,
    ),
  };
});

/**
 * Cancellation penalties (migration 008). Replaces the flat ₹50 fee, which
 * taught abusers exactly where the ceiling was.
 */
export const cancellationConfig = registerAs('cancellation', () => ({
  // Free-cancellation grace period after request.
  graceMinutes: parseFloat(process.env.CANCELLATION_GRACE_MINUTES || '2'),
  // Escalating tiers in paise, indexed by offence count inside the rolling
  // window. The last value applies to every further offence.
  riderPenaltyTiersPaise: (
    process.env.CANCELLATION_RIDER_TIERS_PAISE || '2000,5000,10000'
  )
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v)),
  driverPenaltyTiersPaise: (
    process.env.CANCELLATION_DRIVER_TIERS_PAISE || '5000,10000,20000'
  )
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v)),
  // Rolling window over which offences accumulate.
  windowHours: parseInt(process.env.CANCELLATION_WINDOW_HOURS || '24', 10),
  // Cancellations in the window before the account is auto-suspended.
  autoSuspendThreshold: parseInt(
    process.env.CANCELLATION_AUTO_SUSPEND_THRESHOLD || '0', // 0 = disabled
    10,
  ),
}));

/**
 * Live ETA refresh (migration 007). `rides.durationMin` keeps the original
 * quote; `etaMinutes` is recomputed from the driver's actual position so the
 * rider does not stare at a frozen estimate.
 */
export const etaConfig = registerAs('eta', () => ({
  enabled: (process.env.ETA_REFRESH_ENABLED ?? 'true') === 'true',
  // Sweep interval for active rides. Cheap: one Redis geo read per ride, and
  // the maps provider is only consulted past staleness.
  refreshIntervalSeconds: parseInt(
    process.env.ETA_REFRESH_INTERVAL_SECONDS || '30',
    10,
  ),
  // Skip the provider call unless the stored ETA is at least this stale.
  staleAfterSeconds: parseInt(process.env.ETA_STALE_AFTER_SECONDS || '60', 10),
  // Rides processed per sweep — bounds provider spend and job duration.
  batchSize: parseInt(process.env.ETA_REFRESH_BATCH_SIZE || '200', 10),
}));

/**
 * GPS breadcrumb persistence (migration 007). AGENTS.md §7: location writes
 * never hit Postgres synchronously. Pings land in Redis; this config governs
 * the sampled, batched flush to `ride_route_points`.
 */
export const trackingConfig = registerAs('tracking', () => ({
  // Persist at most one breadcrumb per ride per interval, regardless of how
  // often the driver pings.
  breadcrumbSampleSeconds: parseInt(
    process.env.TRACKING_BREADCRUMB_SAMPLE_SECONDS || '15',
    10,
  ),
  // Buffer flush cadence and size for the batched writer.
  breadcrumbFlushIntervalMs: parseInt(
    process.env.TRACKING_BREADCRUMB_FLUSH_INTERVAL_MS || '5000',
    10,
  ),
  breadcrumbFlushBatchSize: parseInt(
    process.env.TRACKING_BREADCRUMB_FLUSH_BATCH_SIZE || '500',
    10,
  ),
  // Per-driver location-update rate limit. A buggy or hostile client that
  // ships 100 fixes/second would otherwise hammer the geo index.
  locationRateLimitPerMinute: parseInt(
    process.env.TRACKING_LOCATION_RATE_LIMIT_PER_MINUTE || '40',
    10,
  ),
  restRateLimitPerMinute: parseInt(
    process.env.TRACKING_REST_RATE_LIMIT_PER_MINUTE || '60',
    10,
  ),
  // Retention for the breadcrumb trail. Retention is DROP PARTITION.
  breadcrumbRetentionDays: parseInt(
    process.env.TRACKING_BREADCRUMB_RETENTION_DAYS || '90',
    10,
  ),
  // Max plausible ground speed; a jump implying more is rejected as GPS spoof
  // or bad fix.
  maxSpeedKmph: parseInt(process.env.TRACKING_MAX_SPEED_KMPH || '200', 10),
}));

/**
 * Partition maintenance (migration 010). Pre-creates future partitions so an
 * insert can never fail for want of one, and drops elapsed ones so retention
 * is instant rather than a multi-million-row DELETE.
 */
export const partitionConfig = registerAs('partition', () => ({
  enabled: (process.env.PARTITION_MAINTENANCE_ENABLED ?? 'true') === 'true',
  cron: process.env.PARTITION_MAINTENANCE_CRON || '0 1 * * *',
  // How far ahead to pre-create. Must comfortably exceed the cron interval.
  precreateDays: parseInt(process.env.PARTITION_PRECREATE_DAYS || '7', 10),
  precreateMonths: parseInt(process.env.PARTITION_PRECREATE_MONTHS || '2', 10),
  surgeHistoryRetentionDays: parseInt(
    process.env.PARTITION_SURGE_RETENTION_DAYS || '365',
    10,
  ),
}));

/**
 * Realtime transport. The Socket.IO Redis adapter is what makes horizontal
 * scaling correct: without it, a rider connected to pod A never receives a
 * driver location emitted on pod B.
 */
export const realtimeConfig = registerAs('realtime', () => ({
  // Defaults ON. Single-pod deploys pay one extra Redis pub/sub connection
  // pair; multi-pod deploys are silently broken without it, so the safe
  // default is the correct one.
  redisAdapterEnabled:
    (process.env.REALTIME_REDIS_ADAPTER_ENABLED ?? 'true') === 'true',
  // Browser origins allowed to open a socket. Mobile apps send no Origin.
  corsOrigins: process.env.REALTIME_CORS_ORIGINS || '',
  pingIntervalMs: parseInt(
    process.env.REALTIME_PING_INTERVAL_MS || '25000',
    10,
  ),
  pingTimeoutMs: parseInt(process.env.REALTIME_PING_TIMEOUT_MS || '20000', 10),
}));

/**
 * Observability. Metrics are exposed on a SEPARATE port so the scrape endpoint
 * is never reachable from the public ingress that serves the API.
 */
export const observabilityConfig = registerAs('observability', () => ({
  metricsEnabled: (process.env.METRICS_ENABLED ?? 'true') === 'true',
  metricsPort: parseInt(process.env.METRICS_PORT || '9464', 10),
  metricsPath: process.env.METRICS_PATH || '/metrics',
  // Prefix on every metric name, e.g. obbian_http_request_duration_seconds.
  metricsPrefix: process.env.METRICS_PREFIX || 'obbian_',
  // JSON lines in production (machine-parseable), pretty in development.
  logFormat: process.env.LOG_FORMAT || 'json',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Emit slow-query warnings above this threshold.
  slowQueryMs: parseInt(process.env.SLOW_QUERY_MS || '500', 10),
  // Slow-request warning threshold for the latency interceptor.
  slowRequestMs: parseInt(process.env.SLOW_REQUEST_MS || '1000', 10),
}));

/**
 * Redis resilience. Redis is on the critical path for matching, geo, surge and
 * fraud. Without a breaker, one blip fails every active ride; with it, the
 * affected features degrade and the rest of the platform keeps serving.
 */
export const resilienceConfig = registerAs('resilience', () => ({
  breakerEnabled: (process.env.REDIS_BREAKER_ENABLED ?? 'true') === 'true',
  // Consecutive failures before the circuit opens.
  breakerFailureThreshold: parseInt(
    process.env.REDIS_BREAKER_FAILURE_THRESHOLD || '5',
    10,
  ),
  // How long the circuit stays open before a single trial request.
  breakerOpenMs: parseInt(process.env.REDIS_BREAKER_OPEN_MS || '10000', 10),
  // Per-command timeout. Prevents a hung Redis from holding request threads.
  commandTimeoutMs: parseInt(
    process.env.REDIS_COMMAND_TIMEOUT_MS || '1000',
    10,
  ),
}));

/**
 * Referral programme (migration 009). Both reward legs pay real money, so the
 * anti-abuse constraints live in the DB (one referral per account, for life).
 */
export const referralConfig = registerAs('referral', () => ({
  enabled: (process.env.REFERRAL_ENABLED ?? 'true') === 'true',
  refereeRewardPaise: parseInt(
    process.env.REFERRAL_REFEREE_REWARD_PAISE || '5000', // ₹50
    10,
  ),
  referrerRewardPaise: parseInt(
    process.env.REFERRAL_REFERRER_REWARD_PAISE || '10000', // ₹100
    10,
  ),
  // Completed rides before the referral qualifies — blocks signup farming.
  qualifyingRides: parseInt(process.env.REFERRAL_QUALIFYING_RIDES || '1', 10),
  // 0 = unlimited redemptions per code.
  maxRedemptionsPerCode: parseInt(
    process.env.REFERRAL_MAX_REDEMPTIONS_PER_CODE || '0',
    10,
  ),
  codeLength: parseInt(process.env.REFERRAL_CODE_LENGTH || '8', 10),
}));

/**
 * Driver incentives (migration 009). Payout writes exactly one
 * INCENTIVE_CREDIT ledger entry, guarded by the ACHIEVED→PAID transition.
 */
export const incentiveConfig = registerAs('incentive', () => ({
  enabled: (process.env.INCENTIVE_ENABLED ?? 'true') === 'true',
  // Sweep that credits ACHIEVED incentives.
  payoutCron: process.env.INCENTIVE_PAYOUT_CRON || '15 3 * * *',
  payoutBatchSize: parseInt(
    process.env.INCENTIVE_PAYOUT_BATCH_SIZE || '200',
    10,
  ),
  // Ceiling per incentive; a configured bonus above this is rejected at
  // creation rather than discovered at payout time.
  maxBonusPaise: parseInt(
    process.env.INCENTIVE_MAX_BONUS_PAISE || '500000', // ₹5,000
    10,
  ),
}));

/**
 * Geofenced areas (migration 009). Replaces hard-coded city bounding boxes;
 * point-in-polygon runs against a GIST index on the quote path.
 */
export const zonesConfig = registerAs('zones', () => ({
  enabled: (process.env.ZONES_ENABLED ?? 'true') === 'true',
  // Cache TTL for the resolved area set at a coordinate. Areas change rarely,
  // so this keeps ST_Contains off the hot path for repeat pickups.
  cacheTtlSeconds: parseInt(process.env.ZONES_CACHE_TTL_SECONDS || '300', 10),
}));

/**
 * Incident / safety ops (migration 008). Nothing here auto-resolves.
 */
export const incidentConfig = registerAs('incident', () => ({
  // Reference prefix quoted to riders in support conversations, e.g. INC-8F3K2Q.
  referencePrefix: process.env.INCIDENT_REFERENCE_PREFIX || 'INC',
  // ACCIDENT and HARASSMENT are forced to CRITICAL on intake regardless of
  // what the reporter selected.
  autoEscalateCritical:
    (process.env.INCIDENT_AUTO_ESCALATE_CRITICAL ?? 'true') === 'true',
  // Ops webhook for CRITICAL intake. Absent = log only.
  criticalWebhookUrl: process.env.INCIDENT_CRITICAL_WEBHOOK_URL,
  // Goodwill ceiling a single ops action may grant without escalation.
  maxCompensationPaise: parseInt(
    process.env.INCIDENT_MAX_COMPENSATION_PAISE || '200000', // ₹2,000
    10,
  ),
}));

/** Retention sweeps for append-only operational tables. */
export const retentionConfig = registerAs('retention', () => ({
  enabled: (process.env.RETENTION_ENABLED ?? 'true') === 'true',
  cron: process.env.RETENTION_CRON || '45 2 * * *',
  // Webhook dedupe rows only need to outlive the provider's retry horizon.
  processedWebhookDays: parseInt(
    process.env.RETENTION_PROCESSED_WEBHOOK_DAYS || '30',
    10,
  ),
  // Published outbox rows are kept as a replay/audit log, then pruned.
  publishedOutboxDays: parseInt(
    process.env.RETENTION_PUBLISHED_OUTBOX_DAYS || '30',
    10,
  ),
  // Read, non-actionable notifications.
  readNotificationDays: parseInt(
    process.env.RETENTION_READ_NOTIFICATION_DAYS || '90',
    10,
  ),
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
  // Production-readiness additions (migrations 005–010).
  ledgerConfig,
  invoiceConfig,
  complianceConfig,
  cancellationConfig,
  etaConfig,
  trackingConfig,
  partitionConfig,
  realtimeConfig,
  observabilityConfig,
  resilienceConfig,
  referralConfig,
  incentiveConfig,
  zonesConfig,
  incidentConfig,
  retentionConfig,
];
