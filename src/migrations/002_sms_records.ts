import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('sms_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('session_id').notNullable().references('id').inTable('sessions');
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('cpaas_message_id', 255);
    t.string('direction', 10).notNullable();
    t.text('body');
    t.string('status', 20).notNullable().defaultTo('SENT');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('delivered_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE sms_records ADD CONSTRAINT sms_records_direction_check
      CHECK (direction IN ('A_TO_B', 'B_TO_A'))
  `);
  await knex.raw(`
    ALTER TABLE sms_records ADD CONSTRAINT sms_records_status_check
      CHECK (status IN ('SENT', 'DELIVERED', 'FAILED'))
  `);

  await knex.raw('CREATE INDEX idx_sms_session ON sms_records(session_id)');
  await knex.raw('CREATE INDEX idx_sms_tenant ON sms_records(tenant_id)');
  await knex.raw('CREATE INDEX idx_sms_cpaas_id ON sms_records(cpaas_message_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sms_records');
}
