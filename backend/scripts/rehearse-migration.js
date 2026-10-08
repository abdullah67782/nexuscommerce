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
};
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
