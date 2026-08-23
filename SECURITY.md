# Security Policy & Hardening Model

## Reporting
Report vulnerabilities privately to the maintainers (security@ / repo
security advisory). Do not open public issues for exploitable findings.

## Implemented controls

### Authentication & authorization
- Phone-OTP login → JWT access (15 min) + refresh rotation; OTPs hashed,
  attempt-limited, cooldown-enforced, TTL'd in Redis.
- Global JWT guard with explicit `@Public()` opt-out list.
- Role guard (`RIDER`/`DRIVER`/`ADMIN`) on driver + admin surfaces.
- Resource ownership: `RideParticipantGuard` gates every ride-scoped route;
  payment refunds are `ADMIN`-only.

### Injection & input safety
- All SQL goes through parameterized ORM calls — no string-built queries.
- Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`
  (unknown fields rejected, not silently dropped).
- JSON body capped at 64kb; UUID path params pre-validated before DB hits.

### Transport & headers
- helmet defaults (CSP relaxed only for Swagger UI).
- CORS allow-list via `CORS_ORIGINS`; unset denies browser origins
  (mobile clients unaffected).
- `trust proxy=1` behind Render/ALB so throttling sees real client IPs.

### Abuse resistance
- Global rate limiting (throttler) + ride-specific fraud guards:
  velocity (5/h), concurrency (2 active), duplicate-pickup (3/10min),
  GPS implausible-jump rejection (>200 km/h between pings).

### Payments
- Razorpay signature verification server-side; webhook idempotency by event id.
- Client retries can never double-charge (idempotency keys).

## Known gaps / roadmap
- Wallet ledger migration to integer paise + double-entry (ADR-005).
- Secrets currently env-provided; rotate on schedule; add vault at scale.
- Dependency scanning (audit CI step) to be wired into GitHub Actions.
