// Migration 008 (upper-estimate applicability answers) on a DISPOSABLE database already at 007 with products,
// sales, stock, a calendar and a recommendation: nothing existing changes, the new rules hold (one seller cannot
// record a type for another seller's product, history is append-only), and the reversal works only while no
// answer exists (refuses otherwise).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
require('./helpers');
const { migrate, down, status } = require('../db/migrate');

const base = process.env.DB_NAME;
const dbName = `${base.replace(/_test$/, '')}_upgrade8_test`;
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
const rowsOf = (table) => `(SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) FROM ${table} t)`;
const fingerprint = async () => one(`SELECT ${rowsOf('products')} AS products, ${rowsOf('calendar_settings')} AS cal,
  ${rowsOf('calendar_entries')} AS entries, ${rowsOf('replenishment_recommendations')} AS recs, ${rowsOf('forecasts')} AS forecasts`);

test('a database at 007 with products, a calendar and a recommendation', async () => {
  await migrate(db, { target: 7 });
  await db.query(`INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
                  INSERT INTO products (id, name, user_id, category) VALUES (1, 'Mug', 1, 'Home'), (2, 'Theirs', 2, NULL);
                  INSERT INTO inventory_locations (seller_id) VALUES (1);
                  INSERT INTO calendar_settings (seller_id, country_code, confirmed_by) VALUES (1, 'US', 1);
                  INSERT INTO calendar_entries (seller_id, kind, title, start_date, end_date, scope, created_by)
                    VALUES (1, 'closure', 'Stocktake', '2026-11-01', '2026-11-01', 'all', 1);`);
  const loc = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
  await db.query(`INSERT INTO replenishment_recommendations (seller_id, product_id, location_id, planning_date, engine_version, inputs_sha256,
                    status, actionable, suggested_quantity, supplier_id, inputs, output)
                  VALUES (1, 1, $1, '2026-10-13', 'replenishment-2', repeat('b', 64), 'provisional', FALSE, NULL, NULL, '{}', '{}')`, [loc]);
});

let before008;
test('008 applies without changing products, calendars, forecasts or recommendations', async () => {
  before008 = await fingerprint();
  assert.deepEqual(await migrate(db, { target: 8 }), ['008_forecast_upper_estimates']);
  const st = await status(db);
  assert.deepEqual([st.pending.filter(p => p.version <= 8), st.changed], [[], []]);
  assert.deepEqual(await fingerprint(), before008);
});

test('008 rules', async () => {
  const q = (sql, p = []) => db.query(sql, p);
  await assert.rejects(q(`INSERT INTO upper_estimate_settings (seller_id, profile, status, policy_version, updated_by) VALUES (1, 'pk_retail', 'confirmed', 'upper-estimates-policy-1', 1)`), /check/);
  await assert.rejects(q(`INSERT INTO upper_estimate_settings (seller_id, profile, status, policy_version, updated_by) VALUES (1, 'us_general_retail', 'maybe', 'upper-estimates-policy-1', 1)`), /check/);
  await q(`INSERT INTO upper_estimate_settings (seller_id, profile, status, policy_version, updated_by) VALUES (1, 'us_general_retail', 'confirmed', 'upper-estimates-policy-1', 1)`);
  await assert.rejects(q(`INSERT INTO upper_estimate_product_types (seller_id, product_id, department, updated_by) VALUES (1, 1, 'toys', 1)`), /check/);
  await assert.rejects(q(`INSERT INTO upper_estimate_product_types (seller_id, product_id, department, updated_by) VALUES (1, 2, 'foods', 1)`),
    /upper_estimate_product_types_product_fk/, 'another seller\'s product');
  await q(`INSERT INTO upper_estimate_product_types (seller_id, product_id, department, updated_by) VALUES (1, 1, 'household', 1)`);
  await assert.rejects(q(`INSERT INTO upper_estimate_events (seller_id, event, after, actor) VALUES (1, 'product_type_set', '{}', 1)`), /check/, 'a product event names its product');
  await q(`INSERT INTO upper_estimate_events (seller_id, product_id, event, after, actor) VALUES (1, 1, 'product_type_set', '{}', 1)`);
  await assert.rejects(q('UPDATE upper_estimate_events SET after = $1', ['{"x":1}']), /append-only/);
});

test('008 refuses to reverse once answers exist, and changes nothing', async () => {
  await assert.rejects(down(db, 8), /cannot reverse 008/);
  assert.notEqual((await one(`SELECT to_regclass('upper_estimate_settings') AS t`)).t, null);
});

test('008 reverses on a database without answers, and re-applies', async () => {
  await db.query('ALTER TABLE upper_estimate_events DISABLE TRIGGER upper_estimate_events_append_only');
  await db.query('TRUNCATE upper_estimate_events, upper_estimate_product_types, upper_estimate_settings');
  await down(db, 8);
  assert.equal((await one(`SELECT to_regclass('upper_estimate_settings') AS t`)).t, null);
  assert.deepEqual(await fingerprint(), before008, 'existing rows unchanged by the reversal');
  assert.deepEqual(await migrate(db, { target: 8 }), ['008_forecast_upper_estimates']);
  assert.deepEqual(await fingerprint(), before008);
});
