#!/usr/bin/env node
// Backup + rehearsal for pending migrations (docs/migration-runbook.md).
//
//   node scripts/rehearse-migration.js            back up, restore into a scratch
//                                                 copy, migrate the COPY, verify
//   node scripts/rehearse-migration.js --keep     keep the scratch copy afterwards
//
// The real database is only READ (pg_dump). Nothing is migrated there: after a
// successful rehearsal you stop the server and run `npm run migrate` yourself.
// Needs pg_dump / pg_restore / psql on PATH, or PG_BIN pointing at their folder
// (Windows: e.g. "C:\Program Files\PostgreSQL\16\bin").
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { migrate, status, assertSchemaCurrent } = require('../db/migrate');

const keep = process.argv.includes('--keep');
const env = process.env;
const db = { host: env.DB_HOST || 'localhost', port: env.DB_PORT || 5432, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME };
if (!db.database || !db.user) { console.error('DB_NAME and DB_USER must be set in backend/.env'); process.exit(1); }

const exe = (name) => {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  return env.PG_BIN ? path.join(env.PG_BIN, file) : file;
};
const pgEnv = { ...env, PGPASSWORD: db.password || '' };
const conn = ['-h', db.host, '-p', String(db.port), '-U', db.user];
function run(name, args) {
  const r = spawnSync(exe(name), args, { env: pgEnv, encoding: 'utf8' });
  if (r.error) throw new Error(`${name} could not run (${r.error.code}). Install PostgreSQL client tools or set PG_BIN.`);
  if (r.status !== 0) throw new Error(`${name} failed:\n${r.stderr}`);
  return r.stdout;
}
const pool = (database) => new Pool({ ...db, database, max: 2 });

// Counts that must survive the migration unchanged.
const CHECKS = {
  users: 'SELECT COUNT(*)::int AS n FROM users',
  products: 'SELECT COUNT(*)::int AS n FROM products',
  sales: 'SELECT COUNT(*)::int AS n FROM sales',
  sales_units: 'SELECT COALESCE(SUM(quantity), 0)::bigint AS n FROM sales',
  imports: 'SELECT COUNT(*)::int AS n FROM data_uploads',
  // The attributed_sales rule written out, so it can be counted on databases
  // older than the view itself.
  attributed_sales: `SELECT COUNT(*)::int AS n FROM sales s JOIN products p ON p.id = s.product_id
                     LEFT JOIN data_uploads du ON du.id = s.upload_id
                     WHERE p.user_id IS NOT NULL AND (s.upload_id IS NULL OR du.uploaded_by = p.user_id)`,
  upload_versions: 'SELECT COUNT(*)::int AS n FROM upload_versions',
  // The legacy inventory table is never modified (004 copies it, read-only).
  inventory_rows: 'SELECT COUNT(*)::int AS n FROM inventory',
  inventory_units: 'SELECT COALESCE(SUM(stock_level), 0)::bigint AS n FROM inventory',
  // The stock ledger (004) must survive later migrations unchanged.
  stock_counts: 'SELECT COUNT(*)::int AS n FROM stock_snapshots',
  stock_movements: 'SELECT COUNT(*)::int AS n FROM stock_movements',
  stock_movement_units: 'SELECT COALESCE(SUM(quantity), 0)::bigint AS n FROM stock_movements',
  inventory_settings: 'SELECT COUNT(*)::int AS n FROM inventory_policies',
  inventory_setting_values: `SELECT COALESCE(SUM(COALESCE(reorder_threshold, 0) + COALESCE(stale_after_days, 0)), 0)::bigint AS n
                             FROM inventory_policies`,
  // Purchasing (005) must survive later migrations unchanged.
  suppliers: 'SELECT COUNT(*)::int AS n FROM suppliers',
  supplier_links: 'SELECT COUNT(*)::int AS n FROM product_suppliers',
  purchase_orders: 'SELECT COUNT(*)::int AS n FROM purchase_orders',
  purchase_order_versions: 'SELECT COALESCE(SUM(version), 0)::bigint AS n FROM purchase_orders',
  purchase_order_units: 'SELECT COALESCE(SUM(quantity_ordered - quantity_cancelled), 0)::bigint AS n FROM purchase_order_lines',
  received_units: 'SELECT COALESCE(SUM(quantity), 0)::bigint AS n FROM purchase_receipt_lines',
  receipt_adjustment_units: 'SELECT COALESCE(SUM(quantity), 0)::bigint AS n FROM purchase_receipt_adjustments',
  purchase_order_events: 'SELECT COUNT(*)::int AS n FROM purchase_order_events',
  supplier_lead_times: 'SELECT COALESCE(SUM(lead_time_days), 0)::bigint AS n FROM product_suppliers',
  // Recommendations (006) keep their identity: engine version and input fingerprint, row for row.
  recommendations: 'SELECT COUNT(*)::int AS n FROM replenishment_recommendations',
  recommendation_fingerprints: `SELECT COALESCE(md5(string_agg(engine_version || ':' || inputs_sha256 || ':' || status, '|' ORDER BY id)), '-') AS n
                                FROM replenishment_recommendations`,
  // Store calendar (007) and upper-estimate answers (008) must survive later migrations ('n/a' before they exist).
  calendar_entries: 'SELECT COUNT(*)::int AS n FROM calendar_entries',
  calendar_entry_events: 'SELECT COUNT(*)::int AS n FROM calendar_entry_events',
  upper_estimate_answers: 'SELECT COUNT(*)::int AS n FROM upper_estimate_events',
};

// 004: every legacy inventory row is kept as evidence with an outcome, and the
// migrated values are exactly the selected rows, unverified, with no count time.
async function verifyInventoryLedger(p) {
  if ((await p.query("SELECT to_regclass('inventory_legacy_rows') AS t")).rows[0].t === null) return;
  const q = async (sql) => (await p.query(sql)).rows;
  const [evidence] = await q(`SELECT (SELECT COUNT(*) FROM inventory)::int AS legacy,
                                     (SELECT COUNT(*) FROM inventory_legacy_rows)::int AS kept`);
  if (evidence.legacy !== evidence.kept) throw new Error(`004 evidence incomplete: ${evidence.kept} of ${evidence.legacy} inventory rows recorded`);
  const [mismatch] = await q(`SELECT COUNT(*)::int AS n FROM inventory i JOIN inventory_legacy_rows r ON r.inventory_id = i.id
                              WHERE r.stock_level IS DISTINCT FROM i.stock_level OR r.product_id IS DISTINCT FROM i.product_id`);
  if (mismatch.n) throw new Error(`004 evidence differs from the legacy table in ${mismatch.n} row(s)`);
  const [snaps] = await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(s.quantity), 0)::bigint AS units,
                                  COUNT(*) FILTER (WHERE s.verification <> 'unverified' OR s.observed_at IS NOT NULL)::int AS bad
                           FROM stock_snapshots s JOIN stock_snapshot_batches b ON b.id = s.batch_id
                           WHERE b.source_kind = 'legacy_migration'`);
  const [migrated] = await q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(stock_level), 0)::bigint AS units
                              FROM inventory_legacy_rows WHERE outcome = 'migrated'`);
  if (snaps.n !== migrated.n || String(snaps.units) !== String(migrated.units) || snaps.bad) {
    throw new Error(`004 migrated values differ: ${snaps.n} snapshots / ${snaps.units} units vs ${migrated.n} rows / ${migrated.units} units (${snaps.bad} not unverified)`);
  }
  const outcomes = await q('SELECT outcome, COUNT(*)::int AS n FROM inventory_legacy_rows GROUP BY outcome ORDER BY outcome');
  console.log(`   inventory evidence: ${evidence.kept} legacy rows kept (${outcomes.map(o => `${o.outcome} ${o.n}`).join(', ') || 'none'}); `
    + `${snaps.n} unverified values, ${snaps.units} units`);
}
async function counts(p) {
  const out = {};
  for (const [k, sql] of Object.entries(CHECKS)) {
    try { out[k] = String((await p.query(sql)).rows[0].n); } catch { out[k] = 'n/a'; }
  }
  return out;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backups = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const dump = path.join(backups, `${db.database}_pre_migrate_${stamp}.dump`);
  const scratch = `${db.database}_rehearsal_${stamp.toLowerCase()}`;

  const live = pool(db.database);
  const before = await status(live);
  console.log('Applied on the real database:', before.applied.map(r => r.name).join(', ') || '(none — built by the old initDb)');
  console.log('Pending:', before.pending.map(f => f.name).join(', ') || '(none)');
  if (before.changed.length) throw new Error(`Applied migration files were edited: ${before.changed.join(', ')}`);
  const liveCounts = await counts(live);
  await live.end();

  console.log(`\n1. Backup  -> ${dump}`);
  run('pg_dump', [...conn, '-Fc', '-f', dump, db.database]);
  console.log(`   ${(fs.statSync(dump).size / 1024).toFixed(0)} KB`);

  console.log(`2. Restore -> scratch database ${scratch}`);
  run('psql', [...conn, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${scratch}"`]);
  let ok = false;
  try {
    run('pg_restore', [...conn, '-d', scratch, '--no-owner', dump]);
    const copy = pool(scratch);
    try {
      const restored = await counts(copy);
      const mismatch = Object.keys(CHECKS).filter(k => restored[k] !== liveCounts[k]);
      if (mismatch.length) throw new Error(`Restore differs from the real database: ${mismatch.join(', ')}`);
      console.log('   restore verified:', JSON.stringify(restored));

      console.log('3. Migrate the scratch copy');
      const ran = await migrate(copy, { log: (m) => console.log('   ' + m) });
      console.log('   applied:', ran.join(', ') || '(nothing pending)');
      await assertSchemaCurrent(copy);

      console.log('4. Verify');
      const after = await counts(copy);
      // 'n/a' before = that column/table did not exist yet in an old schema; it is
      // reported, not treated as a change. Every count that existed must be equal.
      const missingBefore = Object.keys(CHECKS).filter(k => liveCounts[k] === 'n/a');
      if (missingBefore.length) console.log(`   not countable before migrating (older schema): ${missingBefore.map(k => `${k} -> ${after[k]}`).join(', ')}`);
      const changed = Object.keys(CHECKS).filter(k => liveCounts[k] !== 'n/a' && after[k] !== liveCounts[k]);
      if (changed.length) throw new Error(`Rows changed during migration: ${changed.map(k => `${k} ${liveCounts[k]} -> ${after[k]}`).join('; ')}`);
      await verifyInventoryLedger(copy);
      console.log('   row counts and quarantine unchanged; schema current');
      ok = true;
    } finally {
      await copy.end();
    }
  } finally {
    if (!keep) run('psql', [...conn, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${scratch}"`]);
  }
  console.log(`\nREHEARSAL PASSED${keep ? ` (scratch copy kept: ${scratch})` : ''}.`);
  console.log('Next: stop the backend, run `npm run migrate`, then start it again.');
  console.log(`Keep ${path.basename(dump)} until the migrated app has been checked; restore it with:`);
  console.log(`  dropdb ${db.database} && createdb ${db.database} && pg_restore -d ${db.database} --no-owner "${dump}"`);
  process.exitCode = ok ? 0 : 1;
})().catch((err) => {
  console.error('\nREHEARSAL FAILED — the real database was not changed.\n' + err.message);
  process.exit(1);
});
