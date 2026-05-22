import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tier_pricing', (t) => {
    t.string('tier', 20).notNullable();
    t.string('metric', 64).notNullable();
    t.decimal('unit_price_ngn', 10, 4).notNullable();
    t.integer('included_quantity').defaultTo(0);
    t.string('currency', 8).defaultTo('NGN');
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.primary(['tier', 'metric']);
  });

  await knex.raw(`
    ALTER TABLE tier_pricing ADD CONSTRAINT tier_pricing_tier_check
      CHECK (tier IN ('STARTER', 'GROWTH', 'ENTERPRISE'))
  `);

  await knex.schema.createTable('usage_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('metric', 64).notNullable();
    t.decimal('quantity', 18, 4).notNullable();
    t.timestamp('recorded_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(
    'CREATE INDEX idx_usage_records_tenant_recorded ON usage_records(tenant_id, recorded_at)',
  );
  await knex.raw(
    'CREATE INDEX idx_usage_records_metric ON usage_records(metric)',
  );

  await knex.schema.createTable('billing_periods', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.decimal('total_ngn', 12, 2).defaultTo(0);
    t.string('status', 16).defaultTo('UNPAID');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE billing_periods ADD CONSTRAINT billing_periods_status_check
      CHECK (status IN ('UNPAID', 'PAID', 'VOID'))
  `);

  await knex.raw(
    'CREATE INDEX idx_billing_periods_tenant_period ON billing_periods(tenant_id, period_start DESC)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('billing_periods');
  await knex.schema.dropTableIfExists('usage_records');
  await knex.schema.dropTableIfExists('tier_pricing');
}
