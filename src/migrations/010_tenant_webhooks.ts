import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_webhook_subscriptions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('event_type', 64).notNullable();
    t.boolean('is_enabled').defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

    t.unique(['tenant_id', 'event_type']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_webhook_subscriptions');
}
