import type { Knex } from 'knex';

/**
 * The admin console and the PATCH /admin/tenants/:id/status endpoint were built
 * around a three-state tenant lifecycle (ACTIVE / SUSPENDED / CANCELLED), but
 * 001 never created the column, so the status filter and PATCH 500'd and every
 * DTO fell back to a hardcoded 'ACTIVE'. Add the column the code expects.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.string('status', 20).notNullable().defaultTo('ACTIVE');
  });
  await knex.raw(
    `ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
       CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CANCELLED'))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check');
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('status');
  });
}
