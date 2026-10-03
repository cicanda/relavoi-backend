import type { Knex } from 'knex';

/**
 * Signup no longer mints API credentials; a tenant asks for them from the
 * dashboard once they are ready to integrate. 001 declared both hash columns
 * NOT NULL, which made a credential-less tenant impossible to insert.
 *
 * The UNIQUE index on api_key_hash is unaffected: Postgres treats NULLs as
 * distinct, so any number of tenants can sit without keys while real hashes
 * stay unique. Lookups in POST /auth/token match on a concrete SHA-256 value,
 * so a NULL row can never be matched by an incoming key.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.string('api_key_hash', 255).nullable().alter();
    t.string('api_secret_hash', 255).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Reversing requires every tenant to hold credentials again. Rows created
  // after the forward migration may legitimately have none, so fail loudly
  // rather than inventing hashes nobody holds the plaintext for.
  const [{ count }] = await knex('tenants')
    .whereNull('api_key_hash')
    .orWhereNull('api_secret_hash')
    .count({ count: '*' });
  if (Number(count) > 0) {
    throw new Error(
      `Cannot revert 006: ${count} tenant(s) have no API credentials. ` +
        'Issue keys via POST /auth/rotate-key for each, then retry.',
    );
  }
  await knex.schema.alterTable('tenants', (t) => {
    t.string('api_key_hash', 255).notNullable().alter();
    t.string('api_secret_hash', 255).notNullable().alter();
  });
}
