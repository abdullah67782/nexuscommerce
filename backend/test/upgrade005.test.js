// Migration 005 (suppliers and purchasing) on a DISPOSABLE database already at 004
// with inventory recorded: existing stock rows are untouched, the new rules hold,
// and reversal works only while no purchasing data exists (refuses otherwise,
// changing nothing).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
require('./helpers');
const { migrate, down, status } = require('../db/migrate');

// Later migrations (006+) are pending here by design: this file tests 005 alone.
const assertSchemaCurrent = async (db) => {
  const st = await status(db);
  assert.deepEqual(st.changed, []);
  assert.ok(st.pending.every(p => p.version > 5), 'only migrations after 005 are pending');
};

const base = process.env.DB_NAME;
const dbName = `${base.replace(/_test$/, '')}_upgrade5_test`;
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
const ledger = async () => (await db.query(
  `SELECT (SELECT COUNT(*) FROM stock_snapshots)::int AS snaps, (SELECT COUNT(*) FROM stock_movements)::int AS moves,
          (SELECT COALESCE(SUM(quantity), 0) FROM stock_movements)::int AS units`)).rows[0];

let loc;
test('a database at 004 with recorded inventory', async () => {
  await migrate(db, { target: 4 });
  await db.query(`INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
                  INSERT INTO products (id, name, user_id) VALUES (1, 'Mouse', 1), (2, 'Theirs', 2);
                  INSERT INTO inventory_locations (seller_id) VALUES (1), (2);`);
  loc = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
  const b = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                       VALUES (1, 'c1', repeat('1', 64), 'manual_count', $1, NOW() - INTERVAL '2 days') RETURNING id`, [loc]);
  await db.query(`INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
                  VALUES (1, $1, 1, $2, 10, NOW() - INTERVAL '2 days', 'verified')`, [b.id, loc]);
  await db.query(`INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256, reason)
                  VALUES (1, 1, $1, 'damage', -2, NOW() - INTERVAL '1 day', 'm1', repeat('2', 64), 'broken')`, [loc]);
});

let before004;
test('005 applies without changing the stock ledger', async () => {
  before004 = await ledger();
  assert.deepEqual(await migrate(db, { target: 5 }), ['005_suppliers_purchasing']);
  await assertSchemaCurrent(db);
  assert.deepEqual(await ledger(), before004);
});

test('005 constraints', async () => {
  const s = await one(`INSERT INTO suppliers (seller_id, name) VALUES (1, 'Acme') RETURNING id, default_currency`);
  assert.equal(s.default_currency, 'PKR');
  await assert.rejects(db.query(`INSERT INTO suppliers (seller_id, name) VALUES (1, ' ACME ')`), /suppliers_name_uq/);
  await assert.rejects(db.query(`INSERT INTO suppliers (seller_id, name, default_currency) VALUES (1, 'B', 'pk')`), /check/i);
  await assert.rejects(db.query(`INSERT INTO product_suppliers (seller_id, product_id, supplier_id, unit_cost) VALUES (1, 1, $1, 5)`, [s.id]),
    /check/i, 'a cost needs a currency');
  await assert.rejects(db.query(`INSERT INTO product_suppliers (seller_id, product_id, supplier_id) VALUES (1, 2, $1)`, [s.id]),
    /product_suppliers_product_fk/, "another seller's product");
  const s2 = await one(`INSERT INTO suppliers (seller_id, name) VALUES (1, 'Second') RETURNING id`);
  await db.query(`INSERT INTO product_suppliers (seller_id, product_id, supplier_id, is_preferred) VALUES (1, 1, $1, TRUE)`, [s.id]);
  await assert.rejects(db.query(`INSERT INTO product_suppliers (seller_id, product_id, supplier_id, is_preferred) VALUES (1, 1, $1, TRUE)`, [s2.id]),
    /product_suppliers_one_preferred/);
  await assert.rejects(db.query(
    `INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, status, idempotency_key, content_sha256)
     VALUES (1, $1, $2, 'PKR', 'ordered', 'k', repeat('0', 64))`, [s.id, loc]), /check/i, 'ordered needs approval and order times');
  await assert.rejects(db.query(
    `INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, status, idempotency_key, content_sha256, cancelled_at)
     VALUES (1, $1, $2, 'PKR', 'cancelled', 'k', repeat('0', 64), NOW())`, [s.id, loc]), /check/i, 'cancelling needs a reason');
  await assert.rejects(db.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256)
     VALUES (1, 1, $1, 'receipt', 3, NOW(), 'r', repeat('0', 64))`, [loc]), /stock_movements_receipt_link_check/,
  'a receipt movement must come from a receipt line');
  await db.query('DELETE FROM product_suppliers');
  await db.query('DELETE FROM suppliers');
});

test('005 reverses while no purchasing data exists, restoring the 004 rules', async () => {
  await down(db, 5);
  for (const t of ['suppliers', 'purchase_orders', 'purchase_receipts', 'purchase_order_events']) assert.equal(await exists(t), false, t);
  assert.deepEqual(await ledger(), before004);
  await assert.rejects(db.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256)
     VALUES (1, 1, $1, 'receipt', 3, NOW(), 'r', repeat('0', 64))`, [loc]), /stock_movements_(kind_check|check3)/, 'the 004 rules are back: no receipt kind');
  assert.deepEqual(await migrate(db, { target: 5 }), ['005_suppliers_purchasing']);
});

test('005 refuses to reverse once a supplier exists, and changes nothing', async () => {
  await db.query(`INSERT INTO suppliers (seller_id, name) VALUES (1, 'Kept')`);
  await assert.rejects(down(db, 5), /cannot reverse 005: purchasing data was recorded/);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM suppliers')).n, 1);
  await assertSchemaCurrent(db);
  await assert.rejects(down(db, 4), /Only the latest applied migration/);
});
