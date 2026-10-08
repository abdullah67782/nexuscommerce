// Upgrade tests for migrations 002 and 003 on a DISPOSABLE database (created and dropped
// here; never the development database).
//
//  1. A database built the old way (initDb.js = 001 SQL run directly, no
//     schema_migrations) with legacy data upgrades cleanly and keeps every row.
//  2. Restarting cannot undo 002: the runner is a no-op and startup only checks.
//  3. Reversal works when the data allows it and refuses (changing nothing)
//     once genuine identical orders exist.
//  4. Edited migration files and out-of-date schemas are detected.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
require('./helpers'); // loads .env.test and enforces the *_test database name
const { migrate, down, status, assertSchemaCurrent, MIGRATIONS_DIR } = require('../db/migrate');

const base = process.env.DB_NAME;
const upgradeDb = `${base.replace(/_test$/, '')}_upgrade_test`;
const conn = (database) => new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database, max: 2,
});

let admin, db;
before(async () => {
  admin = conn(base);
  await admin.query(`DROP DATABASE IF EXISTS ${upgradeDb}`);
  await admin.query(`CREATE DATABASE ${upgradeDb}`);
  db = conn(upgradeDb);
});
after(async () => {
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${upgradeDb}`);
  await admin.end();
});

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const count = async (table) => (await one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
const constraintExists = async (name) =>
  (await one('SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = $1', [name])).n === 1;

test('legacy database (built by the old initDb) with existing data', async () => {
  // Exactly what initDb.js did before migrations: run the baseline SQL directly.
  await db.query(fs.readFileSync(path.join(MIGRATIONS_DIR, '001_baseline.sql'), 'utf8'));
  assert.equal((await one(`SELECT to_regclass('schema_migrations') AS t`)).t, null);
  assert.ok(await constraintExists('unique_sale_transaction'));

  await db.query(`
    INSERT INTO users (id, email, password) VALUES (1, 'a@x', 'p'), (2, 'b@x', 'p');
    INSERT INTO data_uploads (id, uploaded_by, file_format, source) VALUES
      (1, 1, 'csv', 'file_upload'), (2, 1, 'api', 'store_connect'), (3, 2, 'csv', 'file_upload'), (4, 1, 'csv', 'file_upload');
    UPDATE data_uploads SET idempotency_key = 'payload:abc', payload_sha256 = repeat('a', 64),
      result_summary = '{"status":"imported","records_imported":2}' WHERE id = 2;
    INSERT INTO products (id, name, user_id, upload_id) VALUES (1, 'Mouse', 1, 1), (2, 'Seeded', 1, NULL);
    INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id) VALUES
      (1, 1, '2026-01-01', NULL, 1), (1, 1, '2026-01-01', NULL, 1),   -- legacy NULL-revenue duplicates
      (1, 2, '2026-01-02', 20, 1),
      (1, 3, '2026-01-03', 30, 2),
      (1, 500, '2026-01-04', 5000, 3),                                 -- B's import on A's product (quarantined)
      (2, 4, '2026-01-01', 40, NULL);                                  -- seeded, no import record
    INSERT INTO upload_versions (seller_id, upload_id, version_number, is_rolled_back) VALUES
      (1, 1, 1, false), (1, 2, 2, false), (2, 3, 1, false), (1, 4, 3, true);
    SELECT setval('users_id_seq', 2); SELECT setval('data_uploads_id_seq', 4); SELECT setval('products_id_seq', 2);
  `);
});

test('migrating records the existing baseline and applies 002 without losing rows', async () => {
  const before = { sales: await count('sales'), products: await count('products'), imports: await count('data_uploads'),
    attributed: await count('attributed_sales') };

  const ran = await migrate(db, { target: 2 });
  assert.deepEqual(ran, ['001_baseline', '002_import_identity']);

  assert.equal(await count('sales'), before.sales);
  assert.equal(await count('products'), before.products);
  assert.equal(await count('data_uploads'), before.imports);
  assert.equal(await count('attributed_sales'), before.attributed, 'quarantine unchanged');

  assert.ok(!(await constraintExists('unique_sale_transaction')), 'legacy content rule removed');
  assert.ok(await constraintExists('upload_versions_seller_version_uq'));
  assert.ok(await constraintExists('data_uploads_source_owner_fk'));

  // Sources backfilled per seller and kind; imports and their sales linked.
  const sources = (await db.query('SELECT seller_id, kind FROM data_sources ORDER BY seller_id, kind')).rows;
  assert.deepEqual(sources, [{ seller_id: 1, kind: 'api' }, { seller_id: 1, kind: 'file' }, { seller_id: 2, kind: 'file' }]);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM data_uploads WHERE source_id IS NULL')).n, 0);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM sales WHERE upload_id IS NOT NULL AND source_id IS NULL')).n, 0);

  // Existing identity and rollback state preserved.
  const api = await one('SELECT idempotency_key, content_sha256, status FROM data_uploads WHERE id = 2');
  assert.equal(api.idempotency_key, 'payload:abc');
  assert.equal(api.content_sha256, 'a'.repeat(64));
  assert.equal((await one('SELECT status FROM data_uploads WHERE id = 4')).status, 'rolled_back');
});

test('after 002: identical genuine rows are allowed, provenance violations are not', async () => {
  const src = (await one(`SELECT id FROM data_sources WHERE seller_id = 1 AND kind = 'file'`)).id;
  await db.query(`INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id, source_id, source_row_number)
                  VALUES (1, 7, '2026-01-09', 70, 1, $1, 1), (1, 7, '2026-01-09', 70, 1, $1, 2)`, [src]);
  await assert.rejects(
    db.query(`INSERT INTO sales (product_id, quantity, sale_date, upload_id, source_id, source_row_number)
              VALUES (1, 7, '2026-01-09', 1, $1, 1)`, [src]), /sales_import_row_uq/);
  await assert.rejects(
    db.query(`INSERT INTO sales (product_id, quantity, sale_date, upload_id, source_id) VALUES (1, 1, '2026-01-09', 3, $1)`, [src]),
    /sale provenance/);
});

test('003 applies on top of 002 without changing rows, and restarting cannot undo either', async () => {
  const before = { sales: await count('sales'), attributed: await count('attributed_sales') };
  assert.deepEqual(await migrate(db), ['003_data_coverage']);
  assert.equal(await count('sales'), before.sales);
  assert.equal(await count('attributed_sales'), before.attributed, 'quarantine unchanged');
  assert.equal((await one(`SELECT COUNT(*)::int AS n FROM attributed_sales WHERE source_id IS NOT NULL`)).n > 0, true,
    'attributed_sales now carries the source');
  assert.deepEqual(await migrate(db), [], 'running migrate again is a no-op');
  await assertSchemaCurrent(db);
  assert.ok(!(await constraintExists('unique_sale_transaction')));
  const st = await status(db);
  assert.deepEqual(st.applied.map(r => r.name), ['001_baseline', '002_import_identity', '003_data_coverage']);
});

test('003 enforces one seller across coverage, source, import and listed products', async () => {
  const src = (await one(`SELECT id FROM data_sources WHERE seller_id = 1 AND kind = 'file'`)).id;
  const ok = await one(`INSERT INTO data_coverage (seller_id, source_id, upload_id, scope, declared_start, declared_end, evidence, declared_by)
                        VALUES (1, $1, 1, 'listed_products', '2026-01-01', '2026-01-31', 'seller_declaration', 1) RETURNING id`, [src]);
  await db.query('INSERT INTO data_coverage_products (coverage_id, product_id, seller_id) VALUES ($1, 1, 1)', [ok.id]);
  // seller 2's import on seller 1's source / declared by someone else / product of another owner
  await assert.rejects(db.query(`INSERT INTO data_coverage (seller_id, source_id, upload_id, scope, declared_start, declared_end, evidence, declared_by)
                                 VALUES (1, $1, 3, 'all_products', '2026-02-01', '2026-02-02', 'seller_declaration', 1)`, [src]), /data_coverage_upload_owner_fk/);
  await assert.rejects(db.query(`INSERT INTO data_coverage (seller_id, source_id, upload_id, scope, declared_start, declared_end, evidence, declared_by)
                                 VALUES (1, $1, 4, 'all_products', '2026-02-01', '2026-02-02', 'seller_declaration', 2)`, [src]), /check/);
  await db.query(`INSERT INTO users (id, email, password) VALUES (3, 'c@x', 'p'); INSERT INTO products (id, name, user_id) VALUES (3, 'Theirs', 3)`);
  await assert.rejects(db.query('INSERT INTO data_coverage_products (coverage_id, product_id, seller_id) VALUES ($1, 3, 1)', [ok.id]),
    /data_coverage_products_product_fk/);
  await assert.rejects(db.query(`INSERT INTO data_coverage (seller_id, source_id, upload_id, scope, declared_start, declared_end, evidence, declared_by)
                                 VALUES (1, $1, 2, 'all_products', '2026-03-05', '2026-03-01', 'seller_declaration', 1)`, [src]), /check/);
  await db.query('DELETE FROM data_coverage');
});

test('003 reverses cleanly (sales kept), and reversal stays latest-first', async () => {
  const salesBefore = await count('sales');
  await assert.rejects(down(db, 2), /Only the latest applied migration/);
  await down(db, 3);
  assert.equal((await one(`SELECT to_regclass('data_coverage') AS t`)).t, null);
  assert.equal(await count('sales'), salesBefore);
  assert.equal((await one(`SELECT COUNT(*)::int AS n FROM information_schema.columns
                           WHERE table_name = 'attributed_sales' AND column_name = 'source_id'`)).n, 0);
});

test('reversal of 002 refuses while genuine identical rows exist, and changes nothing', async () => {
  await assert.rejects(down(db, 2), /cannot reverse 002/);
  assert.ok(await constraintExists('upload_versions_seller_version_uq'), 'still at 002');
  assert.deepEqual((await status(db)).applied.map(r => r.version), [1, 2]);
});

test('reversal of 002 works once the data allows it, and 002 + 003 can be re-applied', async () => {
  await db.query(`DELETE FROM sales WHERE sale_date = '2026-01-09'`);
  const salesBefore = await count('sales');
  await down(db, 2);
  assert.ok(await constraintExists('unique_sale_transaction'));
  assert.equal((await one(`SELECT to_regclass('data_sources') AS t`)).t, null);
  assert.equal(await count('sales'), salesBefore, 'no sale lost by the reversal');
  await assert.rejects(assertSchemaCurrent(db), (err) => err.code === 'SCHEMA_NOT_CURRENT');
  assert.deepEqual(await migrate(db), ['002_import_identity', '003_data_coverage']);
  assert.equal(await count('sales'), salesBefore);
  await assertSchemaCurrent(db);
});

test('an edited, already-applied migration is detected and blocks both migrate and startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-migrations-'));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter(x => x.endsWith('.sql'))) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  fs.appendFileSync(path.join(dir, '001_baseline.sql'), '\n-- edited after being applied\n');
  await assert.rejects(migrate(db, { dir }), /were modified: 001_baseline/);
  await assert.rejects(assertSchemaCurrent(db, dir), /modified migration files: 001_baseline/);
  fs.rmSync(dir, { recursive: true });
});
