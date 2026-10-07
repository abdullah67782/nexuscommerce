// Versioned schema migrations.
//
//   migrations/NNN_name.sql        — applied in order, each in its own transaction
//   migrations/NNN_name.down.sql   — optional manual reversal of NNN
//
// Applied versions and the SHA-256 of each file are recorded in
// schema_migrations. Server startup only CHECKS that the schema is current
// (assertSchemaCurrent); it never runs DDL, so restarting cannot undo a
// migration. Applying is an explicit step:
//
//   npm run migrate            apply pending migrations
//   npm run migrate:status     list applied / pending
//   node db/migrate.js down N  reverse the latest migration N (take a backup first)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 74010001; // pg_advisory_lock key reserved for migrations

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const downFile = file.replace(/\.sql$/, '.down.sql');
      const downPath = path.join(dir, downFile);
      return {
        version: Number(file.slice(0, 3)),
        name: file.replace(/\.sql$/, ''),
        sql,
        checksum: sha256(sql),
        down: fs.existsSync(downPath) ? fs.readFileSync(downPath, 'utf8') : null,
      };
    });
}

async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
}

async function applied(db) {
  const exists = await db.query(`SELECT to_regclass('schema_migrations') AS t`);
  if (!exists.rows[0].t) return [];
  const { rows } = await db.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return rows;
}

// Compare recorded migrations with the files on disk.
async function status(db, dir = MIGRATIONS_DIR) {
  const files = listMigrations(dir);
  const done = await applied(db);
  const doneByVersion = new Map(done.map(r => [r.version, r]));
  const changed = done.filter(r => {
    const f = files.find(x => x.version === r.version);
    return f && f.checksum !== r.checksum;
  }).map(r => r.name);
  const missingFiles = done.filter(r => !files.some(f => f.version === r.version)).map(r => r.name);
  const pending = files.filter(f => !doneByVersion.has(f.version));
  return { files, applied: done, pending, changed, missingFiles };
}

async function migrate(pool, { dir = MIGRATIONS_DIR, target = Infinity, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(client);
    const st = await status(client, dir);
    if (st.changed.length) {
      throw new Error(`Applied migration files were modified: ${st.changed.join(', ')}. Restore them; add a new migration instead.`);
    }
    const ran = [];
    for (const m of st.pending.filter(p => p.version <= target)) {
      log(`applying ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed and was rolled back: ${err.message}`);
      }
      ran.push(m.name);
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Reverse the most recently applied migration (must equal `version`).
async function down(pool, version, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const done = await applied(client);
    const latest = done[done.length - 1];
    if (!latest || latest.version !== version) {
      throw new Error(`Only the latest applied migration can be reversed (latest is ${latest ? latest.name : 'none'}).`);
    }
    const m = listMigrations(dir).find(f => f.version === version);
    if (!m || !m.down) throw new Error(`No down file for migration ${version}.`);
    log(`reversing ${m.name}`);
    await client.query('BEGIN');
    try {
      await client.query(m.down);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Reversing ${m.name} failed and was rolled back: ${err.message}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Used at server startup: refuse to run against an out-of-date schema.
async function assertSchemaCurrent(pool, dir = MIGRATIONS_DIR) {
  const st = await status(pool, dir);
  const problems = [];
  if (st.pending.length) problems.push(`pending migrations: ${st.pending.map(p => p.name).join(', ')}`);
  if (st.changed.length) problems.push(`modified migration files: ${st.changed.join(', ')}`);
  if (st.missingFiles.length) problems.push(`applied migrations missing on disk: ${st.missingFiles.join(', ')}`);
  if (problems.length) {
    const err = new Error(`Database schema is not current (${problems.join('; ')}). `
      + 'Back up the database, then run "npm run migrate".');
    err.code = 'SCHEMA_NOT_CURRENT';
    throw err;
  }
}

module.exports = { migrate, down, status, assertSchemaCurrent, listMigrations, MIGRATIONS_DIR };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const pool = require('../config/db');
  const [cmd = 'up', arg] = process.argv.slice(2);
  const log = (msg) => console.log(msg);
  (async () => {
    if (cmd === 'up') {
      const ran = await migrate(pool, { log });
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Schema already current.');
    } else if (cmd === 'status') {
      const st = await status(pool);
      for (const f of st.files) {
        const done = st.applied.find(a => a.version === f.version);
        console.log(`${done ? 'applied ' : 'pending '} ${f.name}${st.changed.includes(f.name) ? '  (FILE MODIFIED)' : ''}`);
      }
    } else if (cmd === 'down') {
      await down(pool, Number(arg), { log });
      console.log(`Reversed ${arg}.`);
    } else {
      throw new Error(`Unknown command "${cmd}". Use up | status | down <version>.`);
    }
  })().then(() => pool.end(), (err) => { console.error(err.message); pool.end(); process.exit(1); });
}
