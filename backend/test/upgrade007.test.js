// Migration 007 (store calendar) on a DISPOSABLE database already at 006 with stock, purchasing and a
// recommendation: nothing existing changes, the new rules hold, and the reversal works only while no
// calendar data exists (refuses otherwise).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
require('./helpers');
const { migrate, down, status } = require('../db/migrate');

const base = process.env.DB_NAME;
const dbName = `${base.replace(/_test$/, '')}_upgrade7_test`;
const conn = (database) => new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database, max: 2,
});
let admin, db;
before(async () => {
  admin = conn(base);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  db = conn(dbName);
});
after(async () => {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const current = async (upTo) => {
  const st = await status(db);
  assert.deepEqual(st.pending.filter(p => p.version <= upTo).map(p => p.name), []);
  assert.deepEqual(st.changed, []);
};
const NEW_COLUMNS = "- 'lead_time_max_days'";
const rowsOf = (table) => `(SELECT md5(string_agg((to_jsonb(t) ${NEW_COLUMNS})::text, '|' ORDER BY id)) FROM ${table} t)`;
const fingerprint = async () => (await one(
  `SELECT ${rowsOf('stock_snapshots')} AS snaps, ${rowsOf('inventory_policies')} AS policies, ${rowsOf('purchase_orders')} AS orders,
          ${rowsOf('product_suppliers')} AS terms, ${rowsOf('replenishment_recommendations')} AS recs`));

let loc;
test('a database at 006 with stock, terms, an order and a recommendation', async () => {
  await migrate(db, { target: 6 });
  await db.query(`INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
                  INSERT INTO products (id, name, user_id, category) VALUES (1, 'Mouse', 1, 'Tech'), (2, 'Theirs', 2, NULL);
                  INSERT INTO inventory_locations (seller_id) VALUES (1), (2);`);
  loc = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
  const bt = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                        VALUES (1, 'c1', repeat('1', 64), 'manual_count', $1, NOW() - INTERVAL '2 days') RETURNING id`, [loc]);
  await db.query(`INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
                  VALUES (1, $1, 1, $2, 10, NOW() - INTERVAL '2 days', 'verified')`, [bt.id, loc]);
  await db.query(`INSERT INTO inventory_policies (seller_id, product_id, location_id, reorder_threshold, stale_after_days, provenance, safety_stock_units)
                  VALUES (1, 1, $1, 4, 10, 'seller', 3)`, [loc]);
  await db.query(`INSERT INTO suppliers (id, seller_id, name) VALUES (1, 1, 'Acme'), (2, 2, 'Other')`);
  await db.query(`INSERT INTO product_suppliers (seller_id, product_id, supplier_id, lead_time_days) VALUES (1, 1, 1, 7)`);
  await db.query(`INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, idempotency_key, content_sha256)
                  VALUES (1, 1, $1, 'PKR', 'po1', repeat('3', 64))`, [loc]);
  await db.query(`INSERT INTO replenishment_recommendations (seller_id, product_id, location_id, planning_date, engine_version, inputs_sha256,
                    status, actionable, suggested_quantity, supplier_id, inputs, output)
                  VALUES (1, 1, $1, '2026-10-09', 'replenishment-1', repeat('a', 64), 'provisional', TRUE, 5, 1, '{}', '{}')`, [loc]);
});

let before007;
test('007 applies without changing stock, settings, terms, orders or recommendations', async () => {
  before007 = await fingerprint();
  assert.deepEqual(await migrate(db, { target: 7 }), ['007_inventory_calendar']);
  await current(7);
  assert.deepEqual(await fingerprint(), before007);
  assert.equal((await one('SELECT lead_time_max_days FROM product_suppliers')).lead_time_max_days, null);
});

test('007 constraints', async () => {
  const ins = (sql, params = []) => db.query(sql, params);
  const entry = (o = {}) => ins(
    `INSERT INTO calendar_entries (seller_id, kind, title, start_date, end_date, scope, scope_category, scope_product_ids, supplier_id,
       demand_change_pct, extra_delay_days, created_by)
     VALUES ($1, $2, 'x', '2026-11-01', $3, $4, $5, $6, $7, $8, $9, $1) RETURNING id`,
    [o.seller ?? 1, o.kind ?? 'promotion', o.end ?? '2026-11-02', o.scope ?? 'all', o.cat ?? null, o.ids ?? null, o.sup ?? null,
      o.pct ?? null, o.delay ?? null]);
  await assert.rejects(entry({ kind: 'closure', scope: 'products', ids: [1] }), /check/);
  await assert.rejects(entry({ kind: 'supplier_delay', scope: 'supplier', sup: 1 }), /check/, 'a delay needs its days');
  await assert.rejects(entry({ kind: 'supplier_delay', scope: 'supplier', sup: 2, delay: 3 }), /calendar_entries_supplier_fk/, 'another seller\'s supplier');
  await assert.rejects(entry({ kind: 'demand_scenario' }), /check/, 'a demand scenario states its change');
  await assert.rejects(entry({ pct: 2000 }), /demand_change_pct_check/);
  await assert.rejects(entry({ end: '2026-10-01' }), /check/, 'end before start');
  await assert.rejects(entry({ scope: 'category' }), /check/, 'a category scope names it');
  const e = (await entry({ kind: 'demand_scenario', pct: 40 })).rows[0];
  await ins(`INSERT INTO calendar_entry_events (seller_id, entry_id, event, after, actor) VALUES (1, $1, 'created', '{}', 1)`, [e.id]);
  await assert.rejects(ins('DELETE FROM calendar_entry_events'), /append-only/);
  await assert.rejects(ins(`INSERT INTO calendar_entry_events (seller_id, entry_id, event, actor) VALUES (2, $1, 'created', 2)`, [e.id]),
    /calendar_entry_events_entry_fk/, 'another seller cannot write history for it');
  await assert.rejects(ins('UPDATE product_suppliers SET lead_time_max_days = 5'), /lead_time_range_check/, 'slowest ≥ usual');
  await ins('UPDATE product_suppliers SET lead_time_max_days = 12');
  await ins(`INSERT INTO calendar_settings (seller_id, country_code, confirmed_by) VALUES (1, 'PK', 1)`);
  await assert.rejects(ins(`INSERT INTO calendar_settings (seller_id, country_code, confirmed_by) VALUES (2, 'pk', 2)`), /country_code_check/);
});

test('007 refuses to reverse once calendar data exists, and changes nothing', async () => {
  await assert.rejects(down(db, 7), /cannot reverse 007: calendar data was recorded/);
  assert.equal((await one(`SELECT to_regclass('calendar_entries') AS t`)).t !== null, true);
  await current(7);
});

test('007 reverses on a database without calendar data, and re-applies', async () => {
  await db.query('TRUNCATE calendar_entry_events, calendar_entries, calendar_settings');
  await db.query('UPDATE product_suppliers SET lead_time_max_days = NULL');
  const beforeDown = await fingerprint();
  await down(db, 7);
  assert.equal((await one(`SELECT to_regclass('calendar_entries') AS t`)).t, null);
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'product_suppliers' AND column_name = 'lead_time_max_days'`)).rows;
  assert.deepEqual(cols, []);
  assert.deepEqual(await fingerprint(), beforeDown, 'existing rows unchanged by the reversal');
  assert.deepEqual(await migrate(db, { target: 7 }), ['007_inventory_calendar']);
  assert.deepEqual(await fingerprint(), beforeDown);
});
