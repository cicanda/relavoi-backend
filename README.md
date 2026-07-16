# Relavoi Backend

Fastify API server for the Relavoi privacy telephony platform.

Tenants exchange API keys for JWTs and create masking sessions; each session
pairs two participants to one proxy number with atomic, overlap-free
allocation in Redis. Inbound voice/SMS webhooks from Africa's Talking (with
Twilio as failover via a circuit breaker) route in under 500 ms p99. Phone
numbers are AES-256-GCM encrypted at rest with tenant-scoped keys; lookups
go through HMAC-SHA256 hashes. Full architecture in [`CLAUDE.md`](./CLAUDE.md).

## Stack

- Node 20+ (TypeScript, strict mode)
- Fastify 5 (`@fastify/jwt`, `cors`, `formbody`, `rate-limit`, `websocket`)
- PostgreSQL 16 (via Knex)
- Redis 7 (cache + Streams event bus + Pub/Sub fan-out)
- Vitest (unit + integration)
- Prom-client for `/metrics`

## Quick start (local dev)

You need Docker (for Postgres + Redis), Node 20+, and an `.env` file
(`cp .env.example .env`, then fill in `JWT_SECRET` (32+ chars) and
`ENCRYPTION_MASTER_KEY` (64+ chars) — `openssl rand -hex 32` for both).

```bash
npm install
npm run docker:up          # postgres + redis on :5432 and :6379
npm run migrate            # apply the consolidated schema
npm run seed               # dev tenant + user + numbers + operator
npm run seed:pricing
npm run dev                # listens on http://localhost:8080

curl http://localhost:8080/v1/health
```

## Dev credentials (created by `npm run seed`)

| Surface              | Username                  | Password |
|----------------------|---------------------------|----------|
| API key (SDK)        | `sk_test_relavoi_dev_0123456789abcdef` | `secret_test_relavoi_dev_fedcba9876543210` |
| Tenant dashboard     | `dev@chowdeck.com`        | `password123` |
| Operator console     | `admin@relavoi.com`       | `admin123` |

## Project layout

```
src/
  config/             env (Zod), database (Knex), redis, knexfile
  api/
    middleware/       auth, admin-auth, tier-rate-limit, metrics
    routes/           health, tenants, sessions, webhooks, devices,
                      billing, analytics, calls, numbers, admin
  services/           session-manager, number-pool (atomic Lua),
                      call-router, sms-router, webhook-handler,
                      circuit-breaker, event-bus, websocket-server,
                      push-notification, billing-manager, tier-enforcer,
                      tenant-webhook-delivery, audit-logger,
                      africastalking/ (webhook-parser, response-builder,
                      sms-parser, sms-sender)
  workers/            session-expiry, cpaas-health-check, event-consumers,
                      metrics-updater
  utils/              logger (Pino, phone redaction), crypto (AES-256-GCM,
                      HMAC-SHA256), cache, metrics
  migrations/         001_initial_schema (consolidated)
  seeds/              dev-seed, pricing-seed
test/
  unit/               crypto, cache, africastalking, sms-parser, presence
  integration/        admin, billing, call-routing, call-verification,
                      circuit-breaker, health, multi-session-proxy,
                      session-lifecycle, sms-routing, tenant-user-auth
docker/               Dockerfile + docker-compose.{yml,full.yml}
```

## Testing

```bash
npm test                    # unit (49 tests)
npm run test:integration    # integration against the dev DB (85 tests)
```

Integration tests use a separate `relavoi_test` database which is created
on demand. The test runner sets `REDIS_PREFIX=relavoi_test:` so it doesn't
collide with dev keys.

## Environment

All env vars are listed in [`.env.example`](./.env.example) with defaults
and validation rules. Notable ones:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (required) |
| `REDIS_URL` / `REDIS_PREFIX` | Redis URL + key prefix (default `relavoi:`) |
| `JWT_SECRET` | 32+ chars, signs SDK + dashboard + operator tokens |
| `ENCRYPTION_MASTER_KEY` | 64+ chars, derives per-tenant phone-encryption keys via PBKDF2 |
| `CORS_ORIGINS` | Comma-separated allowed origins for the dashboard + admin frontends |
| `AT_API_KEY` / `AT_USERNAME` | Africa's Talking sandbox / prod creds |
| `CB_*` | Circuit-breaker thresholds (5 failures or >10% over 120s → OPEN) |

## Docker / production

```bash
npm run docker:build       # docker build -f docker/Dockerfile -t relavoi-api:latest .
npm run docker:full-up     # full stack: postgres + redis + migrate + api
```

The Dockerfile is multi-stage (builder + runtime), runs as a non-root user,
and exposes a `/v1/health` healthcheck via `wget --spider`.

## SERVICE_MODE deployments

The same binary serves three deployments via `SERVICE_MODE`:

| Mode | Routes mounted | Workers |
|---|---|---|
| `api` (default) | all of `/v1/*` | session-expiry, cpaas-health, metrics-updater, event-consumers |
| `webhook` | only `/v1/health`, `/v1/webhooks/cpaas/*` | none |
| `worker` | only `/v1/health`, `/metrics` | all four |

## Related Repositories

- [relavoi-dashboard](https://github.com/cicanda/relavoi-dashboard) — Tenant web dashboard
- [relavoi-admin](https://github.com/cicanda/relavoi-admin) — Operator console
- [relavoi-android-sdk](https://github.com/cicanda/relavoi-android-sdk) — Android SDK
- [relavoi-ios-sdk](https://github.com/cicanda/relavoi-ios-sdk) — iOS SDK
- [relavoi-docs](https://github.com/cicanda/relavoi-docs) — Documentation site
- [relavoi-infra](https://github.com/cicanda/relavoi-infra) — Terraform infrastructure
