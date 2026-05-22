import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('device_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('user_phone_hash', 64).notNullable();
    t.text('token').notNullable().unique();
    t.string('platform', 16).notNullable();
    t.string('app_bundle_id', 255);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_refreshed_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_platform_check
      CHECK (platform IN ('ios', 'android'))
  `);

  await knex.raw(
    'CREATE INDEX idx_device_tokens_tenant_phone ON device_tokens(tenant_id, user_phone_hash)',
  );
  await knex.raw('CREATE INDEX idx_device_tokens_token ON device_tokens(token)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('device_tokens');
}
