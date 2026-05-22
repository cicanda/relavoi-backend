import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('actor_type', 32).notNullable();
    t.uuid('actor_id');
    t.string('action', 64).notNullable();
    t.string('resource_type', 64).notNullable();
    t.string('resource_id', 255);
    t.jsonb('metadata').defaultTo('{}');
    t.string('ip', 64);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_type_check
      CHECK (actor_type IN ('tenant_user', 'operator', 'system'))
  `);

  await knex.raw('CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC)');
  await knex.raw('CREATE INDEX idx_audit_log_actor ON audit_log(actor_type, actor_id)');
  await knex.raw('CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_log');
}
