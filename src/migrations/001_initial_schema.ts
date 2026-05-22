import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ─── Extensions ─────────────────────────────────────────────────────────────
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // ─── tenants ────────────────────────────────────────────────────────────────
  await knex.schema.createTable('tenants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable();
    t.string('api_key_hash', 255).notNullable().unique();
    t.string('api_secret_hash', 255).notNullable();
    t.string('billing_email', 255);
    t.string('webhook_url', 500);
    t.string('webhook_secret', 255);
    t.integer('default_grace_period').defaultTo(15);
    t.integer('default_session_ttl_min').defaultTo(120);
    t.integer('cooldown_min').defaultTo(5);
    t.string('expired_call_behavior', 20).defaultTo('DEAD_LINE');
    t.string('support_phone', 20);
    t.jsonb('push_config').defaultTo('{}');
    t.boolean('push_enabled').defaultTo(false);
    t.string('push_title_template', 255).defaultTo('Incoming Call');
    t.string('push_body_template', 500).defaultTo('You are receiving a call from {tenant_name}');
    t.boolean('recording_enabled').defaultTo(false);
    t.string('recording_consent_mode', 10).defaultTo('DEFAULT');
    t.string('recording_consent_audio_url', 500);
    t.boolean('sms_auto_reply_on_expired').defaultTo(true);
    t.string('tier', 20).defaultTo('STARTER');
    t.string('workspace_slug', 100);
    t.string('country', 2).defaultTo('NG');
    t.string('industry', 50);
    t.integer('requested_pool_size');
    t.jsonb('onboarding_metadata').defaultTo('{}');
    t.timestamp('api_key_last_used_at', { useTz: true });
    t.uuid('current_billing_period_id'); // FK added below after billing_periods exists
    t.string('billing_currency', 3).defaultTo('NGN');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE tenants ADD CONSTRAINT tenants_expired_call_behavior_check
      CHECK (expired_call_behavior IN ('DEAD_LINE', 'REDIRECT_SUPPORT', 'PLAY_MESSAGE'))
  `);
  await knex.raw(`
    ALTER TABLE tenants ADD CONSTRAINT tenants_recording_consent_mode_check
      CHECK (recording_consent_mode IN ('DEFAULT', 'CUSTOM', 'NONE'))
  `);
  await knex.raw(`
    ALTER TABLE tenants ADD CONSTRAINT tenants_tier_check
      CHECK (tier IN ('STARTER', 'GROWTH', 'ENTERPRISE'))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_tenants_workspace_slug ON tenants(workspace_slug)
      WHERE workspace_slug IS NOT NULL
  `);

  // ─── tenant_users ───────────────────────────────────────────────────────────
  await knex.schema.createTable('tenant_users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('email', 255).notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('name', 255).notNullable();
    t.string('role', 20).notNullable().defaultTo('DEVELOPER');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check
      CHECK (role IN ('OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'))
  `);
  await knex.raw('CREATE UNIQUE INDEX idx_tenant_users_email_unique ON tenant_users(email)');
  await knex.raw('CREATE INDEX idx_tenant_users_tenant ON tenant_users(tenant_id)');

  // ─── proxy_numbers ──────────────────────────────────────────────────────────
  await knex.schema.createTable('proxy_numbers', (t) => {
    t.string('number', 20).primary();
    t.string('region', 20);
    t.string('status', 20).defaultTo('AVAILABLE');
    t.string('provider', 20).defaultTo('AFRICASTALKING');
    t.timestamp('last_used_at', { useTz: true });
    t.timestamp('cooldown_until', { useTz: true });
    t.timestamp('health_check_at', { useTz: true });
    t.timestamp('provisioned_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE proxy_numbers ADD CONSTRAINT proxy_numbers_status_check
      CHECK (status IN ('AVAILABLE', 'IN_USE', 'COOLDOWN', 'QUARANTINED'))
  `);
  await knex.raw(`
    ALTER TABLE proxy_numbers ADD CONSTRAINT proxy_numbers_provider_check
      CHECK (provider IN ('AFRICASTALKING', 'TWILIO', 'PLIVO'))
  `);
  await knex.raw('CREATE INDEX idx_numbers_status_region ON proxy_numbers(status, region)');
  await knex.raw('CREATE INDEX idx_numbers_provider ON proxy_numbers(provider)');
  await knex.raw(`
    CREATE INDEX idx_numbers_cooldown ON proxy_numbers(cooldown_until) WHERE status = 'COOLDOWN'
  `);

  // ─── sessions ───────────────────────────────────────────────────────────────
  await knex.schema.createTable('sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.binary('party_a_phone_enc').notNullable();
    t.binary('party_b_phone_enc').notNullable();
    t.string('party_a_phone_hash', 64).notNullable();
    t.string('party_b_phone_hash', 64).notNullable();
    t.string('proxy_number', 20).notNullable();
    t.string('state', 20).notNullable().defaultTo('PENDING');
    t.string('direction_mode', 20).defaultTo('BIDIRECTIONAL');
    t.jsonb('metadata').defaultTo('{}');
    t.integer('grace_period_min').defaultTo(15);
    t.integer('max_duration_min').defaultTo(120);
    t.boolean('recording_enabled').defaultTo(false);
    t.string('consent_prompt', 10).defaultTo('NONE');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('activated_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.timestamp('expired_at', { useTz: true });
    t.integer('call_count').defaultTo(0);
    t.timestamp('last_call_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE sessions ADD CONSTRAINT sessions_state_check
      CHECK (state IN ('PENDING', 'ACTIVE', 'GRACE_PERIOD', 'EXPIRED', 'FAILED'))
  `);
  await knex.raw(`
    ALTER TABLE sessions ADD CONSTRAINT sessions_direction_mode_check
      CHECK (direction_mode IN ('BIDIRECTIONAL', 'A_TO_B_ONLY', 'B_TO_A_ONLY'))
  `);
  await knex.raw('CREATE INDEX idx_sessions_tenant ON sessions(tenant_id)');
  await knex.raw('CREATE INDEX idx_sessions_state ON sessions(state)');
  await knex.raw(`
    CREATE INDEX idx_sessions_proxy_active ON sessions(proxy_number)
      WHERE state IN ('ACTIVE', 'GRACE_PERIOD')
  `);
  await knex.raw(`
    CREATE INDEX idx_sessions_party_a_active ON sessions(party_a_phone_hash)
      WHERE state IN ('ACTIVE', 'GRACE_PERIOD')
  `);
  await knex.raw(`
    CREATE INDEX idx_sessions_party_b_active ON sessions(party_b_phone_hash)
      WHERE state IN ('ACTIVE', 'GRACE_PERIOD')
  `);
  await knex.raw(`
    CREATE INDEX idx_sessions_expires ON sessions(expires_at)
      WHERE state IN ('ACTIVE', 'GRACE_PERIOD')
  `);
  await knex.raw('ALTER TABLE sessions ENABLE ROW LEVEL SECURITY');

  // ─── call_records ───────────────────────────────────────────────────────────
  await knex.schema.createTable('call_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id').notNullable().references('id').inTable('sessions');
    t.string('cpaas_call_id', 255);
    t.string('cpaas_provider', 20).defaultTo('AFRICASTALKING');
    t.string('direction', 10).notNullable();
    t.string('status', 20).notNullable().defaultTo('RINGING');
    t.integer('duration_seconds');
    t.string('recording_url', 500);
    t.boolean('recording_consent_played').defaultTo(false);
    t.timestamp('initiated_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('answered_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE call_records ADD CONSTRAINT call_records_direction_check
      CHECK (direction IN ('A_TO_B', 'B_TO_A'))
  `);
  await knex.raw(`
    ALTER TABLE call_records ADD CONSTRAINT call_records_status_check
      CHECK (status IN ('RINGING', 'ANSWERED', 'COMPLETED', 'MISSED', 'FAILED'))
  `);
  await knex.raw('CREATE INDEX idx_calls_session ON call_records(session_id)');
  await knex.raw('CREATE INDEX idx_calls_cpaas ON call_records(cpaas_call_id)');

  // ─── sms_records ────────────────────────────────────────────────────────────
  await knex.schema.createTable('sms_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id').notNullable().references('id').inTable('sessions');
    t.string('direction', 10).notNullable();
    t.string('status', 20).notNullable().defaultTo('PENDING');
    t.binary('message_text_enc').notNullable();
    t.string('cpaas_message_id', 255);
    t.string('cpaas_provider', 20).defaultTo('AFRICASTALKING');
    t.string('cost', 20);
    t.timestamp('sent_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('delivered_at', { useTz: true });
  });
  await knex.raw(`
    ALTER TABLE sms_records ADD CONSTRAINT sms_records_direction_check
      CHECK (direction IN ('A_TO_B', 'B_TO_A'))
  `);
  await knex.raw(`
    ALTER TABLE sms_records ADD CONSTRAINT sms_records_status_check
      CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED'))
  `);
  await knex.raw('CREATE INDEX idx_sms_session ON sms_records(session_id)');
  await knex.raw('CREATE INDEX idx_sms_cpaas_id ON sms_records(cpaas_message_id)');

  // ─── webhook_dlq ────────────────────────────────────────────────────────────
  await knex.schema.createTable('webhook_dlq', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('event_id', 255).notNullable();
    t.string('provider', 20).notNullable();
    t.jsonb('payload').notNullable();
    t.text('error_message');
    t.integer('retry_count').defaultTo(0);
    t.integer('max_retries').defaultTo(3);
    t.timestamp('first_received_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('last_retry_at', { useTz: true });
    t.timestamp('resolved_at', { useTz: true });
    t.string('status', 20).defaultTo('PENDING');
  });
  await knex.raw(`
    ALTER TABLE webhook_dlq ADD CONSTRAINT webhook_dlq_status_check
      CHECK (status IN ('PENDING', 'RETRYING', 'RESOLVED', 'ABANDONED'))
  `);
  await knex.raw('CREATE INDEX idx_webhook_dlq_status ON webhook_dlq(status)');
  await knex.raw('CREATE INDEX idx_webhook_dlq_event ON webhook_dlq(event_id)');

  // ─── device_tokens ──────────────────────────────────────────────────────────
  await knex.schema.createTable('device_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('user_phone_hash', 64).notNullable();
    t.string('platform', 10).notNullable();
    t.string('token', 500).notNullable();
    t.string('app_bundle_id', 255);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_refreshed_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_platform_check
      CHECK (platform IN ('ios', 'android'))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_device_tokens_unique
      ON device_tokens(tenant_id, user_phone_hash, token)
  `);
  await knex.raw(`
    CREATE INDEX idx_device_tokens_lookup
      ON device_tokens(tenant_id, user_phone_hash) WHERE is_active = true
  `);
  await knex.raw(`
    CREATE INDEX idx_device_tokens_stale
      ON device_tokens(last_refreshed_at) WHERE is_active = true
  `);

  // ─── billing_periods ────────────────────────────────────────────────────────
  await knex.schema.createTable('billing_periods', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.timestamp('period_start', { useTz: true }).notNullable();
    t.timestamp('period_end', { useTz: true }).notNullable();
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('closed_at', { useTz: true });
    t.unique(['tenant_id', 'period_start']);
  });
  await knex.raw(`
    ALTER TABLE billing_periods ADD CONSTRAINT billing_periods_status_check
      CHECK (status IN ('ACTIVE', 'CLOSED', 'INVOICED', 'PAID'))
  `);
  await knex.raw(`
    CREATE INDEX idx_billing_periods_tenant
      ON billing_periods(tenant_id, period_start DESC)
  `);
  await knex.raw(`
    CREATE INDEX idx_billing_periods_active
      ON billing_periods(tenant_id) WHERE status = 'ACTIVE'
  `);

  // ─── circular FK: tenants.current_billing_period_id → billing_periods ─────
  await knex.raw(`
    ALTER TABLE tenants ADD CONSTRAINT fk_tenants_billing_period
      FOREIGN KEY (current_billing_period_id) REFERENCES billing_periods(id)
  `);

  // ─── usage_records ──────────────────────────────────────────────────────────
  await knex.schema.createTable('usage_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.uuid('billing_period_id').notNullable().references('id').inTable('billing_periods');
    t.string('metric', 30).notNullable();
    t.decimal('quantity', 12, 4).notNullable().defaultTo(0);
    t.decimal('unit_price', 10, 4);
    t.timestamp('recorded_at', { useTz: true }).defaultTo(knex.fn.now());
    t.uuid('session_id').references('id').inTable('sessions');
    t.uuid('call_record_id').references('id').inTable('call_records');
    t.jsonb('metadata').defaultTo('{}');
  });
  await knex.raw(`
    ALTER TABLE usage_records ADD CONSTRAINT usage_records_metric_check
      CHECK (metric IN ('session_created', 'call_minute', 'sms_sent', 'sms_received', 'recording_minute', 'number_rental'))
  `);
  await knex.raw(`
    CREATE INDEX idx_usage_tenant_period ON usage_records(tenant_id, billing_period_id)
  `);
  await knex.raw(`
    CREATE INDEX idx_usage_metric ON usage_records(billing_period_id, metric)
  `);

  // ─── tier_pricing ───────────────────────────────────────────────────────────
  await knex.schema.createTable('tier_pricing', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('tier', 20).notNullable();
    t.string('metric', 30).notNullable();
    t.decimal('unit_price', 10, 4).notNullable();
    t.decimal('included_quantity', 12, 4).defaultTo(0);
    t.decimal('overage_price', 10, 4);
    t.string('currency', 3).defaultTo('NGN');
    t.timestamp('effective_from', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('effective_until', { useTz: true });
    t.unique(['tier', 'metric', 'effective_from']);
  });
  await knex.raw(`
    ALTER TABLE tier_pricing ADD CONSTRAINT tier_pricing_tier_check
      CHECK (tier IN ('STARTER', 'GROWTH', 'ENTERPRISE'))
  `);
  await knex.raw(`
    CREATE INDEX idx_tier_pricing_lookup ON tier_pricing(tier, metric)
      WHERE effective_until IS NULL
  `);

  // ─── webhook_delivery_logs ──────────────────────────────────────────────────
  await knex.schema.createTable('webhook_delivery_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('event_type', 50).notNullable();
    t.string('payload_summary', 500);
    t.string('delivery_url', 500).notNullable();
    t.integer('http_status');
    t.string('response_body', 1000);
    t.boolean('success').defaultTo(false);
    t.integer('attempt_number').defaultTo(1);
    t.timestamp('delivered_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    CREATE INDEX idx_webhook_logs_tenant
      ON webhook_delivery_logs(tenant_id, delivered_at DESC)
  `);

  // ─── operators ──────────────────────────────────────────────────────────────
  await knex.schema.createTable('operators', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('email', 255).notNullable().unique();
    t.string('password_hash', 255).notNullable();
    t.string('name', 255).notNullable();
    t.string('role', 20).notNullable().defaultTo('VIEWER');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_login_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE operators ADD CONSTRAINT operators_role_check
      CHECK (role IN ('ROOT', 'SRE', 'SUPPORT', 'VIEWER'))
  `);

  // ─── audit_log ──────────────────────────────────────────────────────────────
  await knex.schema.createTable('audit_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('actor_type', 20).notNullable();
    t.uuid('actor_id').notNullable();
    t.string('action', 100).notNullable();
    t.string('resource_type', 50).notNullable();
    t.string('resource_id', 255);
    t.jsonb('details').defaultTo('{}');
    t.string('ip_address', 45);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });
  await knex.raw(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
      CHECK (actor_type IN ('operator', 'tenant', 'system'))
  `);
  await knex.raw('CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC)');
  await knex.raw('CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id)');
  await knex.raw('CREATE INDEX idx_audit_time ON audit_log(created_at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('operators');
  await knex.schema.dropTableIfExists('webhook_delivery_logs');
  await knex.schema.dropTableIfExists('tier_pricing');
  await knex.schema.dropTableIfExists('usage_records');
  // Break circular FK before dropping billing_periods
  await knex.raw('ALTER TABLE IF EXISTS tenants DROP CONSTRAINT IF EXISTS fk_tenants_billing_period');
  await knex.schema.dropTableIfExists('billing_periods');
  await knex.schema.dropTableIfExists('device_tokens');
  await knex.schema.dropTableIfExists('webhook_dlq');
  await knex.schema.dropTableIfExists('sms_records');
  await knex.schema.dropTableIfExists('call_records');
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('proxy_numbers');
  await knex.schema.dropTableIfExists('tenant_users');
  await knex.schema.dropTableIfExists('tenants');
}
