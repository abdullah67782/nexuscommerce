// Migration 004 (inventory ledger) on a DISPOSABLE database built the old way,
// with legacy inventory rows of every awkward kind: duplicates, ownerless,
// missing product, negative, NULL threshold, NULL timestamp, a measured zero.
//   * every legacy row is kept as evidence with an explicit outcome;
//   * the legacy `inventory` table is untouched;
//   * migrated values are UNVERIFIED (no count time) and never a baseline;
//   * the new constraints hold;
//   * reversal works only while 004 holds nothing but migrated values, and
//     refuses — changing nothing — once inventory was recorded after it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
require('./helpers');
const { migrate, down, status, MIGRATIONS_DIR } = require('../db/migrate');
// At 004 exactly: nothing edited, only later migrations pending.
const assertSchemaCurrent = async (db) => {
  const st = await status(db);
  assert.deepEqual(st.changed, []);
  assert.ok(st.pending.every(p => p.version > 4), 'only migrations after 004 are pending');
};
const ledger = require('../lib/stockLedger');

const base = process.env.DB_NAME;
const dbName = `${base.replace(/_test$/, '')}_upgrade4_test`;
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

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];
const n = async (sql, params) => (await one(sql, params)).n;
const exists = async (table) => (await one('SELECT to_regclass($1) AS t', [table])).t !== null;
const legacyInventory = () => rows('SELECT id, product_id, stock_level, reorder_threshold, updated_at FROM inventory ORDER BY id');

let inventoryBefore;
let salesBefore;

test('old-style database with legacy inventory rows, migrated to 003', async () => {
  await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, '001_baseline.sql'), 'utf8'));
  await db.query(`
    INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
    INSERT INTO data_uploads (id, uploaded_by, file_format, source) VALUES (1, 1, 'csv', 'file_upload');
    INSERT INTO products (id, name, user_id, upload_id) VALUES
      (1, 'Mouse', 1, 1), (2, 'Cable', 1, 1), (3, 'Lamp', 2, NULL), (4, 'Orphan', NULL, NULL),
      (5, 'NoStock', 1, 1), (6, 'Broken', 1, 1);
    INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id) VALUES
      (1, 2, '2026-01-02', 20, 1), (2, 1, '2026-01-02', 10, 1), (5, 4, '2026-01-03', 40, 1);
    INSERT INTO upload_versions (seller_id, upload_id, version_number) VALUES (1, 1, 1);
    INSERT INTO inventory (id, product_id, stock_level, reorder_threshold, updated_at) VALUES
      (1, 1, 5, 10, '2026-01-01 10:00'),     -- older duplicate for Mouse
      (2, 1, 7, 8,  '2026-02-01 10:00'),     -- newest Mouse row: selected
      (3, 2, 0, 10, '2026-01-15 09:00'),     -- a legacy zero (still unverified)
      (4, 3, 12, NULL, NULL),                -- seller 2, no threshold, no timestamp
      (5, 4, 9, 10, '2026-01-20 00:00'),     -- product without an owner
      (6, NULL, 3, 10, '2026-01-21 00:00'),  -- row without a product
      (7, 6, -2, 10, '2026-01-22 00:00');    -- negative value
    SELECT setval('users_id_seq', 2); SELECT setval('products_id_seq', 6);
    SELECT setval('data_uploads_id_seq', 1); SELECT setval('inventory_id_seq', 7);
  `);
  await migrate(db, { target: 3 });
  inventoryBefore = await legacyInventory();
  salesBefore = await n('SELECT COUNT(*)::int AS n FROM sales');
});

test('004 keeps every legacy row as evidence, with an explicit outcome', async () => {
  assert.deepEqual(await migrate(db, { target: 4 }), ['004_inventory_ledger']);
  await assertSchemaCurrent(db);
  assert.deepEqual(await legacyInventory(), inventoryBefore, 'legacy inventory table untouched');
  assert.equal(await n('SELECT COUNT(*)::int AS n FROM sales'), salesBefore);

  const evidence = await rows('SELECT inventory_id, product_id, owner_id, stock_level, outcome FROM inventory_legacy_rows ORDER BY inventory_id');
  assert.deepEqual(evidence.map(r => [r.inventory_id, r.outcome]), [
    [1, 'duplicate_not_selected'], [2, 'migrated'], [3, 'migrated'], [4, 'migrated'],
    [5, 'ownerless_not_migrated'], [6, 'missing_product'], [7, 'negative_not_migrated'],
  ]);
  assert.deepEqual(evidence.map(r => r.stock_level), [5, 7, 0, 12, 9, 3, -2], 'original values preserved');
});

test('migrated values are unverified, keep their provenance, and are never a baseline', async () => {
  const snaps = await rows(`SELECT s.product_id, s.seller_id, s.quantity, s.observed_at, s.verification, s.legacy_row_id,
                                   s.legacy_recorded_at, b.source_kind, l.snapshot_id = s.id AS linked
                            FROM stock_snapshots s JOIN stock_snapshot_batches b ON b.id = s.batch_id
                            JOIN inventory_legacy_rows l ON l.inventory_id = s.legacy_row_id ORDER BY s.product_id`);
  assert.deepEqual(snaps.map(s => [s.product_id, s.seller_id, s.quantity, s.legacy_row_id]), [[1, 1, 7, 2], [2, 1, 0, 3], [3, 2, 12, 4]]);
  for (const s of snaps) {
    assert.equal(s.verification, 'unverified');
    assert.equal(s.observed_at, null, 'a write time is not a count time');
    assert.equal(s.source_kind, 'legacy_migration');
    assert.equal(s.linked, true);
  }
  assert.equal(snaps[2].legacy_recorded_at, null);

  const policies = await rows('SELECT product_id, reorder_threshold, provenance FROM inventory_policies ORDER BY product_id');
  assert.deepEqual(policies, [
    { product_id: 1, reorder_threshold: 8, provenance: 'legacy_migration' },
    { product_id: 2, reorder_threshold: 10, provenance: 'legacy_migration' },
  ]);
  assert.deepEqual((await rows('SELECT seller_id FROM inventory_locations ORDER BY seller_id')).map(r => r.seller_id), [1, 2]);

  const location = await one('SELECT id, timezone FROM inventory_locations WHERE seller_id = 1');
  const pos = await ledger.positions(db, 1, location);
  assert.equal(pos.get(2).known, false, 'a legacy zero is not a measured zero');
  assert.equal(pos.get(2).on_hand, null);
  assert.deepEqual([pos.get(2).legacy.quantity, pos.get(2).legacy.verification], [0, 'unverified']);
  assert.equal(pos.get(5).known, false);
  assert.equal(pos.get(5).legacy, null, 'no stock record at all stays distinct from an unverified value');
});

test('004 constraints', async () => {
  const loc1 = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
  const loc2 = (await one('SELECT id FROM inventory_locations WHERE seller_id = 2')).id;
  await assert.rejects(db.query('INSERT INTO inventory_locations (seller_id) VALUES (1)'), /inventory_locations_one_default/);
  await db.query(`INSERT INTO inventory_policies (seller_id, product_id, location_id, stale_after_days, provenance) VALUES (1, NULL, $1, 7, 'seller')`, [loc1]);
  await assert.rejects(
    db.query(`INSERT INTO inventory_policies (seller_id, product_id, location_id, stale_after_days, provenance) VALUES (1, NULL, $1, 9, 'seller')`, [loc1]),
    /inventory_policies_default_uq/, 'one seller default per location');
  await assert.rejects(
    db.query(`INSERT INTO inventory_policies (seller_id, product_id, location_id, reorder_threshold, provenance) VALUES (1, 1, $1, 3, 'seller')`, [loc1]),
    /inventory_policies_product_uq/);

  const batch = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                           VALUES (1, 'k1', repeat('1', 64), 'manual_count', $1, '2026-03-01T10:00:00Z') RETURNING id`, [loc1]);
  const snap = (product, qty, extra = {}) => db.query(
    `INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [extra.seller ?? 1, extra.batch ?? batch.id, product, extra.loc ?? loc1, qty,
      'observed' in extra ? extra.observed : '2026-03-01T10:00:00Z', extra.verification ?? 'verified']);
  await snap(1, 4);
  await assert.rejects(snap(1, 5), /stock_snapshots_batch_id_product_id_location_id_key/, 'one item per product per submission');
  const batch2 = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                            VALUES (1, 'k2', repeat('2', 64), 'manual_count', $1, '2026-03-01T10:00:00Z') RETURNING id`, [loc1]);
  await assert.rejects(snap(1, 5, { batch: batch2.id }), /stock_snapshots_one_active_per_instant/,
    'conflicting counts for one instant are never decided by insertion order');
  await assert.rejects(snap(2, 1, { batch: batch2.id, observed: null }), /check/i, 'a verified count needs a time');
  await assert.rejects(snap(3, 1, { batch: batch2.id }), /stock_snapshots_product_fk/, "another seller's product");
  await assert.rejects(snap(2, 1, { batch: batch2.id, loc: loc2 }), /stock_snapshots_location_fk/, "another seller's location");
  await assert.rejects(snap(2, -1, { batch: batch2.id }), /check/i, 'a count is never negative');
  await assert.rejects(db.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256)
     VALUES (1, 1, $1, 'shipment', 2, NOW(), 'm1', repeat('3', 64))`, [loc1]), /check/i, 'a shipment removes stock');
  await assert.rejects(db.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256)
     VALUES (1, 1, $1, 'damage', -2, NOW(), 'm2', repeat('3', 64))`, [loc1]), /check/i, 'damage needs a reason');
  await db.query('DELETE FROM stock_snapshots WHERE batch_id IN ($1, $2)', [batch.id, batch2.id]);
  await db.query('DELETE FROM stock_snapshot_batches WHERE id IN ($1, $2)', [batch.id, batch2.id]);
  await db.query(`DELETE FROM inventory_policies WHERE provenance = 'seller'`);
});

test('004 reverses while it holds only migrated values; the legacy table is intact', async () => {
  await down(db, 4);
  for (const t of ['stock_snapshots', 'stock_movements', 'inventory_policies', 'inventory_legacy_rows', 'inventory_locations']) {
    assert.equal(await exists(t), false, `${t} dropped`);
  }
  assert.deepEqual(await legacyInventory(), inventoryBefore);
  await assert.rejects(db.query(`INSERT INTO data_uploads (uploaded_by, source) VALUES (1, 'stock_count')`), /check/i);
  assert.deepEqual(await migrate(db, { target: 4 }), ['004_inventory_ledger'], 're-applies');
  assert.equal(await n(`SELECT COUNT(*)::int AS n FROM inventory_legacy_rows WHERE outcome = 'migrated'`), 3);
});

for (const [label, write] of [
  ['a recorded count', async (loc) => {
    const b = await one(`INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at)
                         VALUES (1, 'after-004', repeat('4', 64), 'manual_count', $1, NOW() - INTERVAL '1 hour') RETURNING id`, [loc]);
    await db.query(`INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
                    VALUES (1, $1, 1, $2, 11, NOW() - INTERVAL '1 hour', 'verified')`, [b.id, loc]);
  }],
  ['a movement', (loc) => db.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256, reason)
     VALUES (1, 1, $1, 'damage', -1, NOW(), 'after-004', repeat('5', 64), 'broken')`, [loc])],
  ['a seller setting', (loc) => db.query(
    `INSERT INTO inventory_policies (seller_id, product_id, location_id, stale_after_days, provenance) VALUES (1, NULL, $1, 3, 'seller')`, [loc])],
]) {
  test(`004 refuses to reverse after ${label}, and changes nothing`, async () => {
    const loc = (await one('SELECT id FROM inventory_locations WHERE seller_id = 1')).id;
    await write(loc);
    const snapshot = async () => ({
      snaps: await n('SELECT COUNT(*)::int AS n FROM stock_snapshots'),
      moves: await n('SELECT COUNT(*)::int AS n FROM stock_movements'),
      pols: await n('SELECT COUNT(*)::int AS n FROM inventory_policies'),
    });
    const beforeDown = await snapshot();
    await assert.rejects(down(db, 4), /cannot reverse 004: inventory was recorded after the migration/);
    assert.deepEqual(await snapshot(), beforeDown);
    await assertSchemaCurrent(db);
    assert.deepEqual(await legacyInventory(), inventoryBefore);
    // Clean up so the next case starts from migrated values only.
    await db.query(`DELETE FROM stock_snapshots WHERE verification = 'verified'`);
    await db.query(`DELETE FROM stock_snapshot_batches WHERE source_kind <> 'legacy_migration'`);
    await db.query('DELETE FROM stock_movements');
    await db.query(`DELETE FROM inventory_policies WHERE provenance = 'seller'`);
  });
}
