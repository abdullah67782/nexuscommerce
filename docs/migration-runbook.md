# Migration runbook (development database)

The schema is changed only by versioned migrations (`backend/migrations/NNN_*.sql`).
The server never alters the schema on start; it **refuses to start** while a
migration is pending.

## 1. Rehearse (the real database is only read)

```
cd backend
node scripts/rehearse-migration.js
```

On Windows, if `pg_dump` is not on PATH, set `PG_BIN` first, for example:
`set PG_BIN=C:\Program Files\PostgreSQL\16\bin`.

The script:

1. Lists the migrations already applied and those pending on the real database (`DB_NAME` in `backend/.env`).
2. Backs it up with `pg_dump -Fc` to `backend/backups/<db>_pre_migrate_<time>.dump`. This folder is ignored by git.
3. Restores the backup into a scratch database, `<db>_rehearsal_<time>`, and checks that row counts match the real database.
4. Applies the pending migrations to the **scratch copy** only.
5. Checks that the schema is current, and that users, products, sales (rows and units), imports, upload versions and attributed (non-quarantined) sales are unchanged.
6. Drops the scratch copy. Use `--keep` to keep it for inspection.

It prints `REHEARSAL PASSED` or `REHEARSAL FAILED`. On failure, the real database is unchanged.

## 2. Apply

Only after a passed rehearsal:

```
# stop the backend (Ctrl+C)
npm run migrate          # applies the same pending migrations to the real database
npm run migrate:status   # everything applied, nothing pending
npm start
```

## 3. If something is wrong afterwards

- **Preferred:** restore the backup the rehearsal made. The script prints the exact
  `dropdb` / `createdb` / `pg_restore` commands. Imports made after the migration
  are lost and must be redone.
- **Alternative, latest migration only:** `node db/migrate.js down N`, using that
  migration's `.down.sql`.
  - `down 2` refuses (and changes nothing) while genuine identical orders exist.
  - `down 3` removes coverage declarations; sales are kept.

## Rehearsed on

A disposable database built the old way (`001_baseline.sql` run directly, as the old
`initDb.js` did), seeded with `seeder.js`, plus one quarantined cross-seller row:

- **2026-10-07, 001 + 002:** passed. Counts were unchanged, including 900 attributed
  sales out of 901 rows.

The real development database has **not** been migrated by Claude; it is not reachable
from the cloud workspace. Run steps 1 and 2 on your machine.
