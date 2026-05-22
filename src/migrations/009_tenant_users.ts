import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable().references('id').inTable('tenants');
    t.string('email', 255).notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('name', 255);
    t.string('role', 16).notNullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('last_login_at', { useTz: true });

    t.unique(['tenant_id', 'email']);
  });

  await knex.raw(`
    ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_role_check
      CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER'))
  `);

  await knex.raw('CREATE INDEX idx_tenant_users_tenant ON tenant_users(tenant_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tenant_users');
}
