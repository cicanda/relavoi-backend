import type { Knex } from 'knex';

/**
 * Mark which calls and messages were simulated rather than carried.
 *
 * A sandbox session now never reaches the provider, so its records describe
 * something that did not happen on the network. Without a flag they are
 * indistinguishable from real traffic in analytics, in a tenant's call history,
 * and in any future billing reconciliation.
 *
 * `mode` is denormalised onto the record rather than joined from the session,
 * because a session can be retargeted and could in principle be migrated
 * between modes; what matters is the mode in force when the call was routed.
 *
 * Existing rows predate sandbox mode entirely and were all real, carried
 * traffic, so they backfill to live / not-simulated.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('call_records', (t) => {
    t.string('mode', 10).notNullable().defaultTo('sandbox');
    t.boolean('simulated').notNullable().defaultTo(false);
  });
  await knex.raw(`
    ALTER TABLE call_records
      ADD CONSTRAINT call_records_mode_check CHECK (mode IN ('sandbox', 'live'))
  `);
  await knex.raw(`UPDATE call_records SET mode = 'live', simulated = false`);
  await knex.schema.alterTable('call_records', (t) => {
    t.index(['simulated'], 'idx_calls_simulated');
  });

  await knex.schema.alterTable('sms_records', (t) => {
    t.string('mode', 10).notNullable().defaultTo('sandbox');
    t.boolean('simulated').notNullable().defaultTo(false);
  });
  await knex.raw(`
    ALTER TABLE sms_records
      ADD CONSTRAINT sms_records_mode_check CHECK (mode IN ('sandbox', 'live'))
  `);
  await knex.raw(`UPDATE sms_records SET mode = 'live', simulated = false`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sms_records DROP CONSTRAINT IF EXISTS sms_records_mode_check');
  await knex.schema.alterTable('sms_records', (t) => {
    t.dropColumn('simulated');
    t.dropColumn('mode');
  });
  await knex.raw('ALTER TABLE call_records DROP CONSTRAINT IF EXISTS call_records_mode_check');
  await knex.schema.alterTable('call_records', (t) => {
    t.dropIndex(['simulated'], 'idx_calls_simulated');
    t.dropColumn('simulated');
    t.dropColumn('mode');
  });
}
