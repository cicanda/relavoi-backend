import type { Knex } from 'knex';

/**
 * 001 enabled ROW LEVEL SECURITY on sessions but never created a policy.
 * Tenant isolation is enforced at the application layer (every query filters
 * by tenant_id from the JWT), and the app connects as the table owner so the
 * orphaned RLS flag had no effect — it only suggested a protection that does
 * not exist. Disable it until a real policy (plus per-request
 * `app.current_tenant` wiring) is introduced deliberately.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sessions DISABLE ROW LEVEL SECURITY');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sessions ENABLE ROW LEVEL SECURITY');
}
