import type { Knex } from 'knex';

/**
 * Target swap (PATCH /v1/sessions/:id/target) lets one session serve several
 * party B numbers in sequence, so session_id alone no longer identifies who a
 * call reached. Record the party B hash in force at call time.
 *
 * Nullable on purpose: rows written before this migration genuinely do not know
 * their target, and backfilling from sessions.party_b_phone_hash would be wrong
 * for any session that has since been swapped. NULL means "unknown", not "the
 * session's current target".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('call_records', (t) => {
    t.string('party_b_phone_hash', 64).nullable();
    t.index(['party_b_phone_hash'], 'idx_calls_party_b');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('call_records', (t) => {
    t.dropIndex(['party_b_phone_hash'], 'idx_calls_party_b');
    t.dropColumn('party_b_phone_hash');
  });
}
