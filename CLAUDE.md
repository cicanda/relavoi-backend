# Relavoi (Number Masking as a Service)

## Project Overview

Relavoi is a B2B SaaS platform that provides phone number masking as a service for the Nigerian market. It enables businesses (ride-hailing, delivery, e-commerce, healthcare, logistics) to provide privacy-preserving phone communication between their end users without exposing personal contact information.

The product is an API-first service with accompanying mobile SDKs for iOS and Android. Client applications integrate the SDK to get a complete privacy communication layer: call masking, SMS masking, push notifications, real-time call verification, and analytics.

The system sits on top of CPaaS providers (primarily Africa's Talking for Nigeria) and abstracts away telephony integration, number pool management, session lifecycle, and regulatory compliance.

There is no existing dedicated number masking provider in the Nigerian market. Bolt and Uber do not mask numbers in Nigeria. This is a greenfield opportunity.

## Architecture Summary

### Five-Layer Model

1. **Client Applications (Consumer Layer)**: The client's mobile apps and web dashboards. They integrate via SDK or direct API.
2. **Relavoi SDK (Integration Layer)**: Lightweight mobile SDK embedded in client apps. Handles auth, call state detection, push notifications, call verification banners, event callbacks, offline queuing.
3. **Relavoi Platform (Application Layer)**: The core backend. API Gateway, Session Manager, Number Pool Manager, Call Router, Event Bus, Webhook Handler, Analytics Engine.
4. **CPaaS Provider (Telephony Layer)**: Africa's Talking (primary), Twilio (failover). Handles actual call origination, termination, SIP trunking, PSTN connectivity.
5. **Telco Infrastructure (Network Layer)**: Nigerian PSTN and mobile networks (MTN, Airtel, Glo, 9mobile). End users make regular phone calls. No VoIP app required on the user side.

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend Services | Node.js (TypeScript) | High concurrency for webhook/call routing |
| API Framework | Fastify | High performance HTTP handling |
| Primary Database | PostgreSQL 16 | JSONB support, row-level security |
| Cache / Session Store | Redis 7 | Sub-millisecond lookups for call routing |
| Event Bus | Redis Streams (initial), Kafka (at scale) | Upgrade path when events exceed 10k/s |
| Container Runtime | Docker | Standard containerization |
| Orchestration | Kubernetes | Auto-scaling, service discovery |
| iOS SDK | Swift | Native CXCallObserver, APNs access |
| Android SDK | Kotlin | Native TelephonyManager, FCM access |
| CPaaS Primary | Africa's Talking | Nigeria voice/SMS, Africa-native pricing |
| CPaaS Failover | Twilio | Global reliability, fallback |
| CI/CD | GitHub Actions | Container builds, automated testing |
| Monitoring | Prometheus + Grafana + Loki | Full observability |
| Secrets | HashiCorp Vault or AWS KMS | Encryption key management |
| Tenant Dashboard | Next.js (React) | SSR for performance |

## Core Components

### 1. API Gateway

Entry point for all external requests. Handles authentication, rate limiting, request validation, routing.

**Auth Model:**
- API Key + Secret per tenant (B2B client)
- SDK authenticates once at init, receives short-lived JWT (15 min)
- All subsequent calls use JWT; SDK handles refresh transparently
- Webhooks from CPaaS verified via HMAC signature

**Base URL:** `https://api.relavoi.com/v1`

**Core Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /sessions | Create masking session |
| GET | /sessions/{id} | Get session details |
| PATCH | /sessions/{id} | Update session (extend, metadata) |
| POST | /sessions/{id}/end | End session (triggers grace period) |
| GET | /sessions/verify | Call verification check (SDK banner) |
| GET | /sessions/{id}/calls | List calls in session |
| GET | /calls/{call_id} | Individual call details |
| GET | /numbers/pool | Pool status |
| POST | /numbers/provision | Request additional numbers |
| GET | /analytics/usage | Usage summary for billing |
| GET | /analytics/calls | Call analytics with filters |
| POST | /webhooks | Register client webhook URL |
| GET | /webhooks | List registered webhooks |
| GET | /config | Tenant config |
| PATCH | /config | Update tenant config |

**Conventions:**
- All timestamps ISO 8601 UTC
- Phone numbers E.164 format (+234XXXXXXXXXX)
- Cursor-based pagination using `after` parameter
- Errors follow RFC 7807 Problem Details

### 2. Session Manager

Central orchestrator for masking session lifecycle.

**Session States:**

```
PENDING -> ACTIVE -> GRACE_PERIOD -> EXPIRED (terminal)
PENDING -> FAILED -> PENDING (retry)
ACTIVE -> EXPIRED (hard timeout)
```

**Session Data Model:**

```typescript
interface Session {
  id: string;                    // UUID
  tenant_id: string;             // UUID, FK to tenants
  party_a_phone_enc: Buffer;     // AES-256-GCM encrypted agent phone
  party_b_phone_enc: Buffer;     // AES-256-GCM encrypted customer phone
  party_a_phone_hash: string;    // SHA-256 with per-tenant salt, for lookups
  party_b_phone_hash: string;    // SHA-256 with per-tenant salt, for lookups
  proxy_number: string;          // Allocated proxy number
  state: 'PENDING' | 'ACTIVE' | 'GRACE_PERIOD' | 'EXPIRED' | 'FAILED';
  direction_mode: 'BIDIRECTIONAL' | 'A_TO_B_ONLY' | 'B_TO_A_ONLY';
  metadata: Record<string, any>; // Client-attached context (order_id, etc.)
  grace_period_min: number;      // Configurable, default 15
  max_duration_min: number;      // Hard timeout, default 120
  recording_enabled: boolean;    // Whether call recording is active
  consent_prompt: 'DEFAULT' | 'CUSTOM' | 'NONE'; // Recording consent config
  expires_at: Date;
  created_at: Date;
  activated_at: Date | null;
  ended_at: Date | null;
  expired_at: Date | null;
  call_count: number;
  last_call_at: Date | null;
}
```

### 3. Number Pool Manager

Manages virtual phone number (DID) pool from CPaaS provider.

**CRITICAL: Atomic Allocation**

Number allocation MUST be atomic to prevent race conditions that break privacy guarantees. Two concurrent session creation requests checking the same proxy number for participant overlap could both pass and allocate the same number, connecting the wrong parties.

Implementation: Redis Lua script that atomically:
1. Checks participant overlap against all active sessions on candidate number
2. Marks number as in-use
3. Creates session-to-number mapping
4. Returns allocated number or failure

```lua
-- PSEUDOCODE for atomic allocation
-- Keys: pool:{region}:available, proxy:{number}:sessions, phone:{hash}:sessions
-- Must be a single Lua script executed atomically

local candidate = redis.call('SRANDMEMBER', pool_key)
if not candidate then return nil end

-- Check participant overlap
local existing_sessions = redis.call('SMEMBERS', 'proxy:' .. candidate .. ':sessions')
for _, sid in ipairs(existing_sessions) do
  local session = redis.call('HGETALL', 'session:' .. sid)
  if session.party_a_hash == new_party_a or session.party_a_hash == new_party_b
     or session.party_b_hash == new_party_a or session.party_b_hash == new_party_b then
    -- Overlap detected, try next candidate
    -- (loop with retry logic)
  end
end

-- No overlap: atomically assign
redis.call('SREM', pool_key, candidate)
redis.call('SADD', 'proxy:' .. candidate .. ':sessions', new_session_id)
redis.call('SADD', 'phone:' .. party_a_hash .. ':sessions', new_session_id)
redis.call('SADD', 'phone:' .. party_b_hash .. ':sessions', new_session_id)
return candidate
```

**Number Reuse Rules:**
- A proxy number can serve multiple concurrent sessions only if no participant overlaps
- After session expiry, a cooldown period (configurable, default 5 min) prevents immediate reallocation
- Cooldown reduces the chance of a customer calling back and reaching a different agent

**Pool Sizing (Time-Aware Model):**

Do NOT use a simple average. Delivery and ride-hailing traffic has sharp peaks.

```
Required pool = p95_concurrent_sessions(trailing_7_days) * 1.2 + burst_reserve
```

- Track peak utilization continuously
- Auto-provision additional numbers when utilization hits 80% of pool capacity in any 15-minute window
- Alert at 70% sustained utilization

**Pool Health:**
- Periodic test calls to verify number connectivity
- Unhealthy numbers quarantined and replaced automatically
- Alert if available pool drops below 20%

### 4. Call Router

Real-time call routing. When a call arrives on a proxy number, determines forwarding destination.

**Routing Logic:**

```
1. Incoming call on proxy P from caller X
2. Query Redis: active sessions where proxy_number = P
3. For each match: check if X matches party_a_hash or party_b_hash
4. If X = party_a: forward to party_b (and vice versa)
5. Set outbound caller ID to P
6. If no active session: apply tenant's expired_call_behavior
```

**CRITICAL: Latency requirement is < 500ms (p99).** Session lookups MUST use Redis cache, never hit PostgreSQL on the routing path.

**Call Recording Consent Flow:**

When a tenant has recording enabled, the system MUST play a consent announcement before bridging the call. This is a legal requirement under NDPR (Nigeria Data Protection Regulation).

```
1. Incoming call arrives, routing decision made
2. Before connecting to other party, play consent prompt:
   - DEFAULT: "This call may be recorded for quality and safety purposes."
   - CUSTOM: Play tenant-uploaded audio file
   - NONE: Skip (recording must also be disabled; system enforces this)
3. After prompt plays, bridge the call to the other party
4. Recording begins
```

Africa's Talking Voice API supports `<Say>` and `<Play>` actions before `<Dial>`, so this is handled in the webhook response XML/JSON.

**Expired Session Behaviors (configurable per tenant):**
- DEAD_LINE: Play "this number is no longer in service," hang up
- REDIRECT_SUPPORT: Forward to tenant's support number
- PLAY_MESSAGE: Play custom message, hang up

### 5. Webhook Handler

Receives incoming webhooks from CPaaS provider (call events, SMS events).

**Processing Pipeline:**

```
1. Receive POST from CPaaS
2. Validate HMAC signature
3. Check event_id against Redis dedup cache
4. If duplicate: return cached response (do NOT re-execute routing)
5. If new: parse event, route to appropriate handler
6. For incoming_call: pass to Call Router, cache routing result with event_id (TTL 60s)
7. For status events: update session, publish to Event Bus
8. Return HTTP 200 within 1 second
```

**Webhook Retry and Failure Handling:**

This must be bulletproof. CPaaS providers retry failed webhooks.

- **Deduplication**: Every webhook event_id is cached in Redis on first processing (TTL 60s). Retries 2-5 hit the cache and return the same response without re-executing logic.
- **Dead Letter Queue (DLQ)**: Events that fail processing after all attempts go to a Redis-backed DLQ. A separate worker monitors the DLQ, retries with backoff, and alerts after 3 consecutive failures.
- **Idempotency guarantee**: The Call Router never creates duplicate outbound call legs for the same inbound event. The cached routing decision is replayed verbatim.
- **DLQ monitoring**: Dashboard metric + PagerDuty alert if DLQ depth exceeds 10 messages.

### 6. Event Bus

Async message broker decoupling producers from consumers.

**Event Types:**

| Event | Key Consumers |
|-------|--------------|
| session.created | Analytics, Client SDK (WebSocket) |
| session.expired | Analytics, Number Pool Manager |
| call.incoming | Push Service, Client SDK |
| call.answered | Analytics, Client SDK |
| call.ended | Analytics, Client SDK, Post-Call Actions |
| call.failed | Analytics, Alerting |
| sms.sent | Analytics, Client SDK |
| pool.low_availability | Alerting, Auto-Provisioner |

**Implementation**: Redis Streams with consumer groups. Migrate to Kafka when event throughput exceeds 10,000/s.

**WebSocket Fan-Out (CRITICAL):**

WebSocket servers run as multiple replicas behind Kubernetes. A webhook processed by any backend instance must reach the correct WebSocket connection regardless of which replica the client is on.

Solution: Redis Pub/Sub as fan-out layer.

```
1. Event fires (e.g., call.answered on session S)
2. Event handler publishes to Redis Pub/Sub channel: "tenant:{tenant_id}:events"
3. Every WebSocket server replica subscribes to channels for its connected clients
4. The replica holding the target client's connection receives the message and forwards it
```

Each WebSocket server instance on startup:
- Subscribes to Redis Pub/Sub channels for all tenants with active connections
- When a client connects, adds subscription for that tenant's channel (if not already subscribed)
- When a client disconnects and no more clients for that tenant, unsubscribes

This is the same pattern used by Socket.IO's Redis adapter. Do not skip this; without it, real-time events will silently fail to reach clients.

### 7. Push Notification Service

Delivers branded push notifications via FCM (Android) and APNs (iOS).

**Flow:**
1. Agent initiates call via SDK
2. SDK notifies backend
3. Backend publishes call.incoming to Event Bus
4. Push Service consumes event, resolves customer device token
5. Sends branded notification (title/body configurable per tenant)
6. Customer sees notification, phone rings with proxy number

**Device Token Management:** SDK registers/refreshes tokens with backend. Tokens stored per user per tenant.

### 8. Analytics Engine

Aggregates call data, session metrics, usage stats. Powers tenant dashboard and billing metering.

**Key Metrics:**
- Sessions: created, active, expired, failed per period
- Calls: volume, answered, missed, failed per session and tenant
- Average call duration
- Pool utilization rate
- Call setup latency (webhook receipt to forwarding response)
- SDK metrics (version distribution, verification banner impressions)
- Post-call action completion rates

## CPaaS Failover Design

Africa's Talking is primary. Twilio is failover. This is the critical path of the product and requires a concrete failover mechanism.

**Circuit Breaker Pattern:**

```
States: CLOSED (normal) -> OPEN (failed) -> HALF_OPEN (testing recovery)

CLOSED: All traffic routes to Africa's Talking
  - Track: consecutive failures, error rate over 2-min sliding window
  - Trip threshold: 5 consecutive failures OR >10% error rate in 2-min window
  - On trip: transition to OPEN

OPEN: All NEW sessions use Twilio-provisioned numbers
  - Existing sessions on Africa's Talking numbers continue until natural expiry
  - Health check runs every 30 seconds against Africa's Talking API
  - After 5 consecutive successful health checks: transition to HALF_OPEN

HALF_OPEN: Route 10% of new sessions to Africa's Talking
  - If success rate > 95% over 5 minutes: transition to CLOSED
  - If any failure: transition back to OPEN
```

**Important**: Proxy number pools are provider-specific. Failover requires maintaining a secondary pool of Twilio-provisioned Nigerian numbers. Size this at ~20% of primary pool for cost efficiency. Accept that during full failover, capacity is reduced until additional Twilio numbers are provisioned.

**Health Check Endpoint**: A lightweight Africa's Talking API call (e.g., account balance check or a test call to a known number) every 30 seconds.

## SDK Architecture

### Modules

| Module | Responsibility | Platform APIs |
|--------|---------------|--------------|
| Auth | API key validation, JWT management, auto-refresh | Keychain (iOS) / KeyStore (Android) |
| Session | Create, query, extend, end sessions via REST | HTTP client |
| Call Verification | Detect active call, query backend, show banner | CXCallObserver (iOS) / TelephonyManager (Android) |
| Push Handler | Register device tokens, display branded notifications | APNs (iOS) / FCM (Android) |
| Event Stream | WebSocket for real-time events, auto-reconnect | URLSessionWebSocketTask (iOS) / OkHttp (Android) |
| Presence | Report device reachability, app foreground state | App lifecycle observers |
| Offline Queue | Persist pending actions, sync on reconnect | SQLite / Core Data |
| Post-Call UI | Configurable rating prompt, issue reporter | Native UI components |

### Call Verification Flow (Revolut-Style)

```
1. SDK registers call state observer on init
2. OS reports active call (off-hook state) -> SDK sets internal flag
3. User opens client app while flag active
4. SDK fires: GET /v1/sessions/verify?user_phone={hash}&tenant_id={id}
5. Backend checks: active session for this user + call event on proxy within last 60s?
6. YES -> { verified: true, context: "Your Chowdeck rider is calling" } -> green banner
7. NO -> { verified: false } -> red banner: "This call is not from Chowdeck"
```

**Permissions:**
- iOS: No special permission. CXCallObserver works without user prompt.
- Android: READ_PHONE_STATE required. Must be declared in manifest, requested at runtime.

### SDK Init Example

```typescript
// Initialize (once at app startup)
Relavoi.initialize(apiKey: 'sk_live_abc123', tenantId: 'tenant_xyz')

// Create session when order is assigned
const session = await Relavoi.sessions.create({
  agentPhone: '+2348012345678',
  customerPhone: '+2348087654321',
  metadata: { orderId: 'ORD-9281', type: 'delivery' },
  gracePeriodMinutes: 15,
  directionMode: 'bidirectional',
  recordingEnabled: false
})

// session.proxyNumber is now available for the app UI

// Listen for events
Relavoi.events.onCallAnswered((event) => { /* update UI */ })
Relavoi.events.onCallEnded((event) => { /* trigger post-call flow */ })

// End session when delivery complete
await Relavoi.sessions.end(session.id)
```

## Call Flow Sequences

### Agent Calls Customer (Primary Flow)

```
1. Agent taps "Call Customer" in client app
2. SDK confirms active session, retrieves proxy number
3. SDK triggers push notification to customer: "Your [Brand] driver is calling"
4. App opens native dialer with proxy number (tel:// URI)
5. Agent's phone dials proxy over PSTN
6. Call arrives at Africa's Talking -> webhook to Relavoi Webhook Handler
7. Webhook Handler validates, deduplicates, passes to Call Router
8. Call Router queries Redis for session matching proxy + caller
9. Match found. If recording enabled:
   a. Respond with consent prompt audio action
   b. After prompt, connect to customer with caller ID = proxy
10. If recording not enabled: connect directly
11. Customer's phone rings. Sees proxy number + push notification
12. Customer answers. Parties bridged. Events stream to Event Bus
13. Call ends. Events published. Analytics recorded. SDK callbacks fire.
```

### Customer Calls Back (Active Session)

```
1. Customer dials proxy from call history / app
2. Webhook to Relavoi
3. Call Router finds active session where party_b_hash matches customer
4. Forward to agent. Caller ID = proxy
5. Agent sees proxy number, recognizes it
```

### Customer Calls Back (Expired Session)

Configurable per tenant:
- **DEAD_LINE**: Play message, hang up
- **REDIRECT_SUPPORT**: Forward to tenant support number
- **PLAY_MESSAGE**: Play custom audio, hang up

### SMS Masking

```
1. Agent sends SMS to proxy number
2. CPaaS webhook to Relavoi
3. Lookup session by proxy + sender
4. Send outbound SMS from proxy to other party
5. Reply follows same flow in reverse
```

## Database Schema

### PostgreSQL Tables

**tenants**
```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  api_key_hash VARCHAR(255) NOT NULL UNIQUE,
  api_secret_hash VARCHAR(255) NOT NULL,
  webhook_url VARCHAR(500),
  webhook_secret VARCHAR(255),
  default_grace_period INT DEFAULT 15,
  expired_call_behavior VARCHAR(20) DEFAULT 'DEAD_LINE'
    CHECK (expired_call_behavior IN ('DEAD_LINE', 'REDIRECT_SUPPORT', 'PLAY_MESSAGE')),
  support_phone VARCHAR(20),
  push_config JSONB DEFAULT '{}',
  recording_enabled BOOLEAN DEFAULT false,
  recording_consent_mode VARCHAR(10) DEFAULT 'DEFAULT'
    CHECK (recording_consent_mode IN ('DEFAULT', 'CUSTOM', 'NONE')),
  recording_consent_audio_url VARCHAR(500),
  tier VARCHAR(20) DEFAULT 'STARTER'
    CHECK (tier IN ('STARTER', 'GROWTH', 'ENTERPRISE')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

**sessions**
```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  party_a_phone_enc BYTEA NOT NULL,
  party_b_phone_enc BYTEA NOT NULL,
  party_a_phone_hash VARCHAR(64) NOT NULL,
  party_b_phone_hash VARCHAR(64) NOT NULL,
  proxy_number VARCHAR(20) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'ACTIVE', 'GRACE_PERIOD', 'EXPIRED', 'FAILED')),
  direction_mode VARCHAR(20) DEFAULT 'BIDIRECTIONAL'
    CHECK (direction_mode IN ('BIDIRECTIONAL', 'A_TO_B_ONLY', 'B_TO_A_ONLY')),
  metadata JSONB DEFAULT '{}',
  grace_period_min INT DEFAULT 15,
  max_duration_min INT DEFAULT 120,
  recording_enabled BOOLEAN DEFAULT false,
  consent_prompt VARCHAR(10) DEFAULT 'NONE',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  activated_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  call_count INT DEFAULT 0,
  last_call_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX idx_sessions_proxy ON sessions(proxy_number) WHERE state IN ('ACTIVE', 'GRACE_PERIOD');
CREATE INDEX idx_sessions_party_a ON sessions(party_a_phone_hash) WHERE state IN ('ACTIVE', 'GRACE_PERIOD');
CREATE INDEX idx_sessions_party_b ON sessions(party_b_phone_hash) WHERE state IN ('ACTIVE', 'GRACE_PERIOD');
CREATE INDEX idx_sessions_state ON sessions(state);
CREATE INDEX idx_sessions_expires ON sessions(expires_at) WHERE state IN ('ACTIVE', 'GRACE_PERIOD');

-- Row-level security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.current_tenant')::UUID);
```

**call_records**
```sql
CREATE TABLE call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id),
  cpaas_call_id VARCHAR(255),
  cpaas_provider VARCHAR(20) DEFAULT 'AFRICASTALKING',
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('A_TO_B', 'B_TO_A')),
  status VARCHAR(20) NOT NULL DEFAULT 'RINGING'
    CHECK (status IN ('RINGING', 'ANSWERED', 'COMPLETED', 'MISSED', 'FAILED')),
  duration_seconds INT,
  recording_url VARCHAR(500),
  recording_consent_played BOOLEAN DEFAULT false,
  initiated_at TIMESTAMPTZ DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE INDEX idx_calls_session ON call_records(session_id);
CREATE INDEX idx_calls_cpaas ON call_records(cpaas_call_id);
```

**proxy_numbers**
```sql
CREATE TABLE proxy_numbers (
  number VARCHAR(20) PRIMARY KEY,
  region VARCHAR(20),
  status VARCHAR(20) DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'IN_USE', 'COOLDOWN', 'QUARANTINED')),
  provider VARCHAR(20) DEFAULT 'AFRICASTALKING'
    CHECK (provider IN ('AFRICASTALKING', 'TWILIO', 'PLIVO')),
  last_used_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  health_check_at TIMESTAMPTZ,
  provisioned_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_numbers_status_region ON proxy_numbers(status, region);
CREATE INDEX idx_numbers_provider ON proxy_numbers(provider);
CREATE INDEX idx_numbers_cooldown ON proxy_numbers(cooldown_until) WHERE status = 'COOLDOWN';
```

**webhook_events (dead letter queue tracking)**
```sql
CREATE TABLE webhook_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(255) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  first_received_at TIMESTAMPTZ DEFAULT now(),
  last_retry_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'))
);
```

### Redis Data Structures

```
# Active session cache (Hash, TTL = max_duration)
session:{session_id} -> { tenant_id, party_a_hash, party_b_hash, proxy_number, state, ... }

# Sessions per proxy number (Set)
proxy:{proxy_number}:sessions -> { session_id_1, session_id_2, ... }

# Sessions per phone number (Set)
phone:{phone_hash}:sessions -> { session_id_1, ... }

# Available numbers per region (Set)
pool:{region}:available -> { +234XXXXXXX, ... }

# Rate limiting (Sorted Set with TTL members)
tenant:{tenant_id}:rate -> { request_timestamps... }

# Webhook deduplication (String, TTL 60s)
webhook:dedup:{event_id} -> { cached_response_json }

# WebSocket fan-out (Pub/Sub channels)
tenant:{tenant_id}:events -> (publish/subscribe)

# Circuit breaker state
cpaas:circuit:{provider} -> { state, failure_count, last_check, opened_at }
```

## Security

### Encryption
- **At rest**: Phone numbers AES-256-GCM encrypted with tenant-specific keys via KMS. Hashes (SHA-256 + per-tenant salt) stored separately for lookups.
- **In transit**: TLS 1.3 external, mTLS internal between K8s services.
- **In cache**: Redis stores encrypted phone data. Decryption only in Call Router at forwarding time.

### Privacy
- Phone numbers never logged in plaintext. Logs use hashed/masked representations.
- API responses never return both parties' real numbers. Only proxy number visible.
- Session data hard-deleted after retention period (default 90 days).
- NDPR compliance: DPAs with CPaaS providers, data residency docs, breach notification procedures.
- Call recording requires consent prompt (see Call Router section). System enforces: if recording_enabled = true, consent_prompt cannot be 'NONE'.

### Abuse Prevention
- Rate limiting per tenant on session creation
- Max concurrent sessions per tenant per tier
- Call duration limits (default 60 min)
- Anomaly detection for unusual patterns
- Number quarantine for abuse reports

## Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Call routing latency | < 500ms p99 | Webhook receive to forwarding response |
| Session creation | < 1s p99 | API request to ACTIVE state |
| Push notification | < 2s p95 | Call initiation to device notification |
| Call verification | < 300ms p99 | SDK request to result |
| API uptime | 99.9% | Monthly |
| Webhook processing uptime | 99.95% | Critical path |

## Infrastructure

### Kubernetes Services

| Service | Min Replicas | Scaling Trigger | Resources |
|---------|-------------|----------------|-----------|
| API Gateway | 2 | Request rate > 500/s | 0.5 CPU / 512MB |
| Webhook Handler | 3 (critical) | Queue depth | 1 CPU / 1GB |
| Session Manager | 2 | Active sessions | 0.5 CPU / 512MB |
| Call Router | 3 (latency critical) | Call volume | 1 CPU / 1GB |
| Number Pool Manager | 1 (singleton, leader election) | N/A | 0.25 CPU / 256MB |
| Push Service | 2 | Notification queue | 0.5 CPU / 512MB |
| WebSocket Server | 2 | Connected clients | 0.5 CPU / 1GB |
| Analytics Worker | 1 | Event backlog | 1 CPU / 2GB |

### Deployment
- Primary region: AWS Cape Town or closest to Nigeria
- All services containerized (Docker), orchestrated via K8s
- Internal comms over private VPC
- Only API Gateway and Webhook Handler are internet-facing
- Webhook Handler uses static IP (CPaaS whitelisting)
- TLS 1.3 on all external endpoints
- WSS with JWT auth on WebSocket handshake

## Nigerian Market Notes

### Regulatory
- NCC has combated ILLEGAL call masking (SIM box fraud for international rate evasion). Our product is fundamentally different: privacy-preserving proxy for authenticated platform users, domestic calls only, full call records maintained.
- NDPR requires both parties be informed if calls are recorded. System enforces consent prompts.
- Proxy numbers provisioned through licensed CPaaS providers (Africa's Talking holds NCC approvals).
- SIM-NIN compliance is the CPaaS provider's responsibility for virtual numbers.

### Network Resilience
- SDK offline queue for action persistence during network drops
- WebSocket auto-reconnect with exponential backoff
- PSTN calls for end-user leg (more reliable than VoIP on Nigerian networks)
- Session state is server-side; reconnecting devices resume seamlessly

### USSD Fallback (Phase 4, accelerate if client demand)
- Feature phones can still RECEIVE masked calls fine (PSTN works on any phone)
- USSD is for session lookup/interaction without a smartphone app
- Initial target clients (Bolt, Chowdeck, Glovo) have smartphone-dominant users
- If a client like GIG Logistics with feature-phone couriers signs up, move USSD to Phase 2

## Implementation Phases

### Phase 1: Core Platform (Months 1-3)
- API Gateway with tenant auth and rate limiting
- Session Manager with full lifecycle
- Number Pool Manager with atomic allocation and recycling
- Call Router with Redis lookups and consent prompt flow
- Webhook Handler with deduplication and DLQ
- Call recording consent mechanism
- Basic tenant dashboard
- Integration tests with Africa's Talking sandbox

### Phase 2: SDK and Value-Add (Months 3-5)
- Android SDK (Kotlin): auth, sessions, call verification, push
- iOS SDK (Swift): same feature set
- SMS masking through existing sessions
- Post-call feedback UI components
- WebSocket event streaming with Redis Pub/Sub fan-out
- Tenant webhook delivery system
- CPaaS circuit breaker implementation

### Phase 3: Scale and Polish (Months 5-7)
- Analytics engine and usage reporting
- Billing metering and subscription tiers
- Twilio failover pool provisioning
- Auto-provisioning for number pool scaling (time-aware model)
- Tenant self-service onboarding
- API documentation site

### Phase 4: Expansion (Months 7+)
- WhatsApp Business API masking
- USSD fallback for feature phones (accelerate if needed)
- Multi-country expansion (Ghana, Kenya, South Africa)
- Call recording with encrypted storage
- AI-powered call quality monitoring
- Enterprise SSO and advanced RBAC

## Code Style and Conventions

- TypeScript strict mode throughout backend
- ESLint + Prettier enforced via CI
- All API responses typed with shared interfaces
- Database migrations via a migration tool (e.g., Knex, Prisma Migrate)
- Tests: unit tests for business logic, integration tests for API endpoints, E2E tests for call flows against CPaaS sandbox
- Commit messages: conventional commits format
- Branch strategy: main (production), develop (staging), feature/* branches
- PR reviews required before merge
- Never log plaintext phone numbers. Ever.
