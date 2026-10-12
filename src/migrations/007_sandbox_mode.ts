import type { Knex } from 'knex';

/**
 * Sandbox by default; live requires explicit activation.
 *
 * Key storage: a tenant can hold both a test and a live pair at once, so one
 * column cannot serve both. The existing api_key_hash / api_secret_hash pair
 * becomes the TEST pair and two new columns hold the live pair. Which pair an
 * incoming credential is checked against is decided by its prefix
 * (rk_test_ / rk_live_), so the two can never be confused for one another.
 *
 * Existing tenants all hold rk_live_ credentials and have placed real calls, so
 * their current pair is moved into the live columns and their mode is set to
 * live. Their test columns are left NULL: they have never had sandbox keys, and
 * inventing some would hand out credentials nobody asked for.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.string('mode', 10).notNullable().defaultTo('sandbox');
    t.string('live_api_key_hash', 255).nullable();
    t.string('live_api_secret_hash', 255).nullable();
  });
  await knex.raw(`
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_mode_check CHECK (mode IN ('sandbox', 'live'))
  `);
  // Unique like its test-pair counterpart, so two tenants can never share a
  // live key. NULLs stay distinct, so any number of tenants may hold none.
  await knex.raw(`
    CREATE UNIQUE INDEX tenants_live_api_key_hash_unique
      ON tenants (live_api_key_hash) WHERE live_api_key_hash IS NOT NULL
  `);

  // Carry existing credentials over to the live columns and grandfather those
  // tenants into live mode. Anything created after migration 006 may have no
  // credentials at all, and those correctly stay in sandbox.
  await knex.raw(`
    UPDATE tenants
       SET live_api_key_hash    = api_key_hash,
           live_api_secret_hash = api_secret_hash,
           mode                 = 'live',
           api_key_hash         = NULL,
           api_secret_hash      = NULL
     WHERE api_key_hash IS NOT NULL
  `);

  // Which mode a session was opened under decides whether it may reach the
  // carrier. Backfilled from the tenant so historical rows read correctly.
  await knex.schema.alterTable('sessions', (t) => {
    t.string('mode', 10).notNullable().defaultTo('sandbox');
  });
  await knex.raw(`
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_mode_check CHECK (mode IN ('sandbox', 'live'))
  `);
  await knex.raw(`
    UPDATE sessions s SET mode = t.mode FROM tenants t WHERE s.tenant_id = t.id
  `);
  await knex.schema.alterTable('sessions', (t) => {
    t.index(['mode'], 'idx_sessions_mode');
  });

  // Only live usage is billable. Existing rows were all real spend.
  await knex.schema.alterTable('usage_records', (t) => {
    t.string('mode', 10).notNullable().defaultTo('sandbox');
  });
  await knex.raw(`
    ALTER TABLE usage_records
      ADD CONSTRAINT usage_records_mode_check CHECK (mode IN ('sandbox', 'live'))
  `);
  await knex.raw(`UPDATE usage_records SET mode = 'live'`);
  await knex.schema.alterTable('usage_records', (t) => {
    t.index(['mode'], 'idx_usage_mode');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Fold live credentials back into the single legacy pair. A tenant holding
  // both pairs would lose its test keys here, which is the correct trade: the
  // pre-migration schema has nowhere to put them.
  await knex.raw(`
    UPDATE tenants
       SET api_key_hash    = live_api_key_hash,
           api_secret_hash = live_api_secret_hash
     WHERE live_api_key_hash IS NOT NULL
  `);
  await knex.raw('DROP INDEX IF EXISTS tenants_live_api_key_hash_unique');
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_mode_check');
  await knex.raw('ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_mode_check');
  await knex.raw('ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_mode_check');
  await knex.schema.alterTable('usage_records', (t) => {
    t.dropIndex(['mode'], 'idx_usage_mode');
    t.dropColumn('mode');
  });
  await knex.schema.alterTable('sessions', (t) => {
    t.dropIndex(['mode'], 'idx_sessions_mode');
    t.dropColumn('mode');
  });
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('live_api_secret_hash');
    t.dropColumn('live_api_key_hash');
    t.dropColumn('mode');
  });
}
