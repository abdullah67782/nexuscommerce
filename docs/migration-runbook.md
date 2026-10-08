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
5. Checks that the schema is current, and that users, products, sales (rows and units), imports, upload versions, attributed (non-quarantined) sales and the legacy `inventory` table (rows and units) are unchanged.
   After 004 it also checks that every legacy inventory row was kept as evidence in `inventory_legacy_rows` with the same values, and that the migrated stock values are exactly the selected rows, all **unverified** with no count time. It prints the outcomes (migrated, duplicate not selected, ownerless, missing product, negative).
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
  - `down 4` works only while the ledger holds nothing but the migrated legacy values.
    Once any count, movement, seller setting, source mapping or stock-count import has
    been recorded, it **refuses and changes nothing** (it never discards inventory
    silently). Preservation path: restore the pre-migration backup, or export the
    `stock_*` / `inventory_*` tables first. The legacy `inventory` table is never
    modified by 004, so after a reversal it holds exactly its earlier values.

## Rehearsed on

A disposable database built the old way (`001_baseline.sql` run directly, as the old
`initDb.js` did), seeded with `seeder.js`, plus one quarantined cross-seller row:

- **2026-10-07, 001 + 002:** passed. Counts were unchanged, including 900 attributed
  sales out of 901 rows.

- **2026-10-08, 004 (inventory ledger):** passed on an old-style database at 003 with
  34 legacy inventory rows (duplicates, ownerless, negative): 34 rows kept as evidence,
  29 migrated as unverified values (827 units), every other count unchanged
  (`docs/evidence/inventory-stage1a/rehearsal_old_style_db.txt`). Also passed on the
  demo database before it was migrated (`rehearsal_demo_db.txt`).

### 004 on your machine

1. Rehearse as above (`node scripts/rehearse-migration.js`), then stop the backend and `npm run migrate`.
2. Stock recorded by old uploads appears as **unverified** ("old value N, unverified") until you record a count. Nothing is lost: `inventory` and `inventory_legacy_rows` keep every original row.
3. Optional demo stock (development only): with the backend running, `node scripts/demo-inventory-data.js http://localhost:5000/api <email> <password>` for a seller that has the forecasting demo products.

The real development database has **not** been migrated by Claude; it is not reachable
from the cloud workspace. Run steps 1 and 2 on your machine.
