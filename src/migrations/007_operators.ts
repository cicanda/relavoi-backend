import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('operators', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('email', 255).notNullable().unique();
    t.string('name', 255);
    t.string('password_hash', 255).notNullable();
    t.string('role', 32).notNullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('last_login_at', { useTz: true });
  });

  await knex.raw(`
    ALTER TABLE operators ADD CONSTRAINT operators_role_check
      CHECK (role IN ('ROOT', 'SRE', 'SUPPORT'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operators');
}
