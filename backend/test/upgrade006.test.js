// Migration 006 (replenishment) on a DISPOSABLE database already at 005 with stock
// and purchasing recorded: nothing existing changes, the new rules hold, and the
// reversal works only while no replenishment data exists (refuses otherwise).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
require('./helpers');
const { migrate, down, status } = require('../db/migrate');
// Later migrations (007+) may be pending here: this file checks 006 only.
const assertSchemaCurrent = async (d) => {
  const st = await status(d);
  assert.deepEqual(st.pending.filter(p => p.version <= 6).map(p => p.name), []);
  assert.deepEqual(st.changed, []);
};

const base = process.env.DB_NAME;
const dbName = `${base.replace(/_test$/, '')}_upgrade6_test`;
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
const exists = async (t) => (await one('SELECT to_regclass($1) AS t', [t])).t !== null;
// Content, not counts: an md5 of every existing row (its pre-006 columns) in a stable order.
const NEW_COLUMNS = "- 'review_period_days' - 'safety_stock_units' - 'source_recommendation_id'";
const rowsOf = (table) => `(SELECT md5(string_agg((to_jsonb(t) ${NEW_COLUMNS})::text, '|' ORDER BY id)) FROM ${table} t)`;
const fingerprint = async () => (await one(
  `SELECT ${rowsOf('stock_snapshots')} AS snaps, ${rowsOf('stock_movements')} AS moves,
          ${rowsOf('inventory_policies')} AS policies, ${rowsOf('purchase_orders')} AS orders,
          ${rowsOf('purchase_order_lines')} AS lines`));

let loc, loc2;
test('a database at 005 with stock, a setting and a purchase order', async () => {
  await migrate(db, { target: 5 });
  await db.query(`INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
                  INSERT INTO products (id, name, user_id) VALUES (1, 'Mouse', 1), (2, 'Theirs', 2);
                  INSERT INTO inventory_locations (seller_id) VALUES (1), (2);`);
  loc = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
  loc2 = (await one('SELECT id FROM inventory_locations WHERE seller_id = 2')).id;
  const b = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                       VALUES (1, 'c1', repeat('1', 64), 'manual_count', $1, NOW() - INTERVAL '2 days') RETURNING id`, [loc]);
  await db.query(`INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
                  VALUES (1, $1, 1, $2, 10, NOW() - INTERVAL '2 days', 'verified')`, [b.id, loc]);
  await db.query(`INSERT INTO inventory_policies (seller_id, product_id, location_id, reorder_threshold, stale_after_days, provenance)
                  VALUES (1, 1, $1, 4, 10, 'seller')`, [loc]);
  await db.query(`INSERT INTO suppliers (id, seller_id, name) VALUES (1, 1, 'Acme'), (2, 2, 'Other')`);
  const po = await one(`INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, idempotency_key, content_sha256)
                        VALUES (1, 1, $1, 'PKR', 'po1', repeat('3', 64)) RETURNING id`, [loc]);
  await db.query(`INSERT INTO purchase_order_lines (seller_id, po_id, product_id, quantity_ordered, pack_size, min_order_qty) VALUES (1, $1, 1, 12, 6, 6)`, [po.id]);
});

let before006;
test('006 applies without changing stock, settings or purchasing rows', async () => {
  before006 = await fingerprint();
  assert.deepEqual(await migrate(db, { target: 6 }), ['006_replenishment']);
  await assertSchemaCurrent(db);
  assert.deepEqual(await fingerprint(), before006);
  const p = await one('SELECT review_period_days, safety_stock_units, reorder_threshold FROM inventory_policies');
  assert.deepEqual(p, { review_period_days: null, safety_stock_units: null, reorder_threshold: 4 });
});

const rec = (o = {}) => db.query(
  `INSERT INTO replenishment_recommendations (seller_id, product_id, location_id, planning_date, engine_version, inputs_sha256,
     status, actionable, suggested_quantity, supplier_id, inputs, output)
   VALUES ($1, $2, $3, '2026-10-09', 'replenishment-1', $4, $5, $6, $7, $8, '{}', '{}') RETURNING id`,
  [o.seller ?? 1, o.product ?? 1, o.loc ?? loc, o.sha ?? 'a'.repeat(64), o.status ?? 'provisional', o.actionable ?? true,
    o.qty ?? 20, o.supplier === undefined ? 1 : o.supplier]);

test('006 constraints', async () => {
  await assert.rejects(db.query('UPDATE inventory_policies SET review_period_days = 29'), /review_period_days_check/);
  await assert.rejects(db.query('UPDATE inventory_policies SET safety_stock_units = -1'), /safety_stock_units_check/);
  const r = (await rec()).rows[0];
  await assert.rejects(rec(), /replenishment_recommendations_identity_uq/, 'same inputs, same engine: one row');
  await assert.rejects(db.query('UPDATE replenishment_recommendations SET status = $1', ['indicative']), /append-only/);
  await assert.rejects(db.query('DELETE FROM replenishment_recommendations'), /append-only/);
  await assert.rejects(rec({ sha: 'b'.repeat(64), status: 'indicative' }), /actionable_check/, 'only provisional can be actionable');
  await assert.rejects(rec({ sha: 'c'.repeat(64), qty: 0 }), /actionable_check/);
  await assert.rejects(rec({ sha: 'd'.repeat(64), product: 2 }), /product_fk/, 'another seller\'s product');
  await assert.rejects(rec({ sha: 'e'.repeat(64), supplier: 2 }), /supplier_fk/, 'another seller\'s supplier');
  const mk = (key, seller = 1, l = loc, s = 1) => db.query(
    `INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, idempotency_key, content_sha256, source_recommendation_id)
     VALUES ($1, $2, $3, 'PKR', $4, repeat('4', 64), $5)`, [seller, s, l, key, r.id]);
  await mk('from-rec');
  await assert.rejects(mk('from-rec-again'), /purchase_orders_one_per_recommendation/, 'one order per recommendation');
  await db.query(`UPDATE purchase_orders SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'test'
                  WHERE idempotency_key = 'from-rec'`);
  await mk('from-rec-after-cancel');                       // a cancelled order no longer holds the recommendation
  await assert.rejects(mk('theirs', 2, loc2, 2), /purchase_orders_recommendation_fk/, 'another seller cannot link it');
});

test('006 refuses to reverse once recommendations exist, and changes nothing', async () => {
  await assert.rejects(down(db, 6), /cannot reverse 006: replenishment data was recorded/);
  assert.equal(await exists('replenishment_recommendations'), true);
  await assertSchemaCurrent(db);
});

test('006 reverses on a database without replenishment data', async () => {
  // A fresh copy at 005 + 006 with the same pre-006 rows only.
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}_b`);
  await admin.query(`CREATE DATABASE ${dbName}_b`);
  const b = conn(`${dbName}_b`);
  try {
    await migrate(b, { target: 6 });
    await b.query(`INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p');
                   INSERT INTO inventory_locations (seller_id) VALUES (1);
                   INSERT INTO inventory_policies (seller_id, location_id, stale_after_days, provenance)
                   SELECT 1, id, 9, 'seller' FROM inventory_locations`);
    await b.query('UPDATE inventory_policies SET review_period_days = 14');
    await assert.rejects(down(b, 6), /review-period\/safety-stock settings=1/, 'a seller setting is data too');
    await b.query('UPDATE inventory_policies SET review_period_days = NULL');
    await down(b, 6);
    assert.equal((await b.query("SELECT to_regclass('replenishment_recommendations') AS t")).rows[0].t, null);
    const cols = (await b.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_policies'
                                 AND column_name IN ('review_period_days', 'safety_stock_units')`)).rows;
    assert.deepEqual(cols, []);
    assert.equal((await b.query('SELECT stale_after_days FROM inventory_policies')).rows[0].stale_after_days, 9);
    assert.deepEqual(await migrate(b, { target: 6 }), ['006_replenishment'], 're-applies');
  } finally {
    await b.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}_b`);
  }
});
