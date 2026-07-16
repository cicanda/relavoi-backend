import type { Knex } from 'knex';

/**
 * device-token registration upserts with `.onConflict('token')`, which requires
 * a UNIQUE constraint on device_tokens.token. 001 created the column without it,
 * so every registration 500'd ("no unique or exclusion constraint matching the
 * ON CONFLICT specification"). Add the unique index.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop any duplicate tokens first so the unique index can be created.
  await knex.raw(`
    DELETE FROM device_tokens a
    USING device_tokens b
    WHERE a.ctid < b.ctid AND a.token = b.token
  `);
  await knex.schema.alterTable('device_tokens', (t) => {
    t.unique(['token'], { indexName: 'device_tokens_token_unique' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('device_tokens', (t) => {
    t.dropUnique(['token'], 'device_tokens_token_unique');
  });
}
