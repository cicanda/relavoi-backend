import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // ─── tenants ────────────────────────────────────────────────────────────────
  await knex.schema.createTable('tenants', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable();
    t.string('api_key_hash', 255).notNullable().unique();
    t.string('api_secret_hash', 255).notNullable();
    t.string('webhook_url', 500);
    t.string('webhook_secret', 255);
    t.integer('default_grace_period').defaultTo(15);
    t.string('expired_call_behavior', 20).defaultTo('DEAD_LINE');
    t.string('support_phone', 20);
    t.jsonb('push_config').defaultTo('{}');
    t.boolean('recording_enabled').defaultTo(false);
    t.string('recording_consent_mode', 10).defaultTo('DEFAULT');
    t.string('recording_consent_audio_url', 500);
    t.string('tier', 20).defaultTo('STARTER');
    t.string('status', 20).defaultTo('ACTIVE');
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
    ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
      CHECK (status IN ('ACTIVE', 'SUSPENDED', 'TRIAL'))
  `);

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
  await knex.raw(
    "CREATE INDEX idx_numbers_cooldown ON proxy_numbers(cooldown_until) WHERE status = 'COOLDOWN'",
  );

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
  await knex.raw(
    "CREATE INDEX idx_sessions_proxy ON sessions(proxy_number) WHERE state IN ('ACTIVE', 'GRACE_PERIOD')",
  );
  await knex.raw(
    "CREATE INDEX idx_sessions_party_a ON sessions(party_a_phone_hash) WHERE state IN ('ACTIVE', 'GRACE_PERIOD')",
  );
  await knex.raw(
    "CREATE INDEX idx_sessions_party_b ON sessions(party_b_phone_hash) WHERE state IN ('ACTIVE', 'GRACE_PERIOD')",
  );
  await knex.raw('CREATE INDEX idx_sessions_state ON sessions(state)');
  await knex.raw(
    "CREATE INDEX idx_sessions_expires ON sessions(expires_at) WHERE state IN ('ACTIVE', 'GRACE_PERIOD')",
  );

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

  await knex.raw('CREATE INDEX idx_dlq_status ON webhook_dlq(status)');
  await knex.raw('CREATE INDEX idx_dlq_event_id ON webhook_dlq(event_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webhook_dlq');
  await knex.schema.dropTableIfExists('call_records');
  await knex.schema.dropTableIfExists('sessions');
  await knex.schema.dropTableIfExists('proxy_numbers');
  await knex.schema.dropTableIfExists('tenants');
}
