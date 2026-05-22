import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('webhook_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('provider', 20).notNullable();
    t.string('event_id', 255);
    t.jsonb('payload').notNullable();
    t.timestamp('processed_at', { useTz: true }).defaultTo(knex.fn.now());
    t.string('status', 20).notNullable();
    t.text('error_message');
  });

  await knex.raw('CREATE INDEX idx_webhook_logs_event_id ON webhook_logs(event_id)');
  await knex.raw('CREATE INDEX idx_webhook_logs_provider ON webhook_logs(provider)');

  await knex.schema.createTable('webhook_delivery_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('event_type', 64).notNullable();
    t.string('url', 500).notNullable();
    t.string('signature', 255);
    t.integer('status_code');
    t.integer('attempt').defaultTo(1);
    t.boolean('succeeded').defaultTo(false);
    t.text('error');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(
    'CREATE INDEX idx_webhook_delivery_tenant_created ON webhook_delivery_logs(tenant_id, created_at DESC)',
  );
  await knex.raw(
    'CREATE INDEX idx_webhook_delivery_event_type ON webhook_delivery_logs(event_type)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webhook_delivery_logs');
  await knex.schema.dropTableIfExists('webhook_logs');
}
