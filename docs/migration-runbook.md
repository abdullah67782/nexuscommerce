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
`set PG_BIN=C:\Program Files\PostgreSQL\18\bin` (use the version folder that exists on your machine; this one has 18).

The script:

1. Lists the migrations already applied and those pending on the real database (`DB_NAME` in `backend/.env`).
2. Backs it up with `pg_dump -Fc` to `backend/backups/<db>_pre_migrate_<time>.dump`. This folder is ignored by git.
3. Restores the backup into a scratch database, `<db>_rehearsal_<time>`, and checks that row counts match the real database.
4. Applies the pending migrations to the **scratch copy** only.
5. Checks that the schema is current, and that users, products, sales (rows and units), imports, upload versions, attributed (non-quarantined) sales and the legacy `inventory` table (rows and units) are unchanged.
   It also checks stock counts and movements (rows and units), inventory settings (rows and values) and, from 005 on, suppliers, supplier terms, purchase orders (rows and versions), ordered, received and adjusted units, and order events.
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
  - `down 5` works only while no supplier, supplier terms, purchase order, receipt or
    purchasing stock movement exists; otherwise it **refuses and changes nothing**.
    Receipts and order history are append-only and are never deleted.
  - `down 6` works only while no replenishment recommendation, recommendation-linked
    order or review-period / safety-stock setting exists; otherwise it **refuses and
    changes nothing**.

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

- **2026-10-08, 005 (suppliers and purchasing):** passed on the demo database at 004
  (7 counts, 4 movements, 6 settings). Every count was unchanged, including the stock
  ledger (`docs/evidence/inventory-stage1b/rehearsal_005.txt`). The rehearsal now also
  checks stock counts, movements (rows and units) and inventory settings.

- **2026-10-08, 006 (replenishment):** passed on the demo database at 005 (10 counts,
  19 movements, 4 purchase orders with receipts and adjustments). Every count was
  unchanged, including the new purchasing checks
  (`docs/evidence/inventory-stage2/rehearsal_006.txt`).

- **2026-10-10, 006 on the Windows development database:** rehearsal passed (every
  compared count unchanged, including purchasing), applied, `migrate:status` shows
  001–006 applied; the replenishment smoke test passed with the real ML server
  (`docs/inventory-stage2-report.md` §8).

- **2026-10-13, 007 + 008 (store calendar; upper-estimate answers):** passed on a disposable database at 006
  (sales, stock counts, supplier terms and a recommendation). Every count was unchanged, including recommendation
  fingerprints and supplier lead times (`docs/evidence/inventory-stage3/rehearsal_007_008_cloud.txt`). The rehearsal now
  also checks recommendations (rows and engine/fingerprint/status), supplier lead times, calendar entries and
  upper-estimate answers.

- **2026-10-13, 007 + 008 on the Windows development database:** rehearsal passed (every compared count unchanged,
  including the 7 recommendations' fingerprints), applied, `migrate:status` shows 001–008 applied; `smoke-stage3.js`
  27/27 with the real ML server (`docs/evidence/inventory-stage3/activation_laptop_2026-10-13.txt`). Backup kept:
  `nexuscommerce_pre_migrate_20261013T171338.dump`.

### 007 + 008 on your machine

1. Stop every running backend, then `node scripts/rehearse-migration.js`. Expect `Pending: 007_inventory_calendar, 008_forecast_upper_estimates` and `REHEARSAL PASSED`.
2. `npm run migrate`, then `npm run migrate:status` (001–008 applied), then `npm start`. The backend refuses to start until both are applied.
3. Both features stay off until you switch them on:
   - `INVENTORY_CALENDAR_ENABLED=true` makes replenishment use the calendar (`replenishment-2`). While it is off, the numbers are exactly `replenishment-1`.
   - `FORECAST_UPPER_ESTIMATES_ENABLED=true` turns on the upper-estimate panel.
4. Reversal:
   - `down 8` works only while no upper-estimate answer exists.
   - `down 7` works only while no calendar setting, confirmation, entry or declared lead-time range exists.
   - Otherwise each refuses and changes nothing. Restore the backup instead.

### 006 on your machine

1. Stop every running backend, then `node scripts/rehearse-migration.js` (expect `Pending: 006_replenishment` and `REHEARSAL PASSED`).
2. `npm run migrate`, `npm run migrate:status`, `npm start`.
3. The Replenishment tab needs `FORECAST_V2_ENABLED=true` and the ML server running; otherwise it shows "forecast unavailable" and no quantities (stock and orders are still shown).

### 004 on your machine

1. Rehearse as above (`node scripts/rehearse-migration.js`), then stop the backend and `npm run migrate`.
2. Stock recorded by old uploads appears as **unverified** ("old value N, unverified") until you record a count. Nothing is lost: `inventory` and `inventory_legacy_rows` keep every original row.
3. Optional demo stock (development only): with the backend running, `node scripts/demo-inventory-data.js http://localhost:5000/api <email> <password>` for a seller that has the forecasting demo products.

The real development database has **not** been migrated by Claude; it is not reachable
from the cloud workspace. Run steps 1 and 2 on your machine.
