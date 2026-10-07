# Import identity and data coverage

Status (merged into `main`; coverage on `feature/forecast-v2`):

| Part | State |
|---|---|
| A. Versioned migrations | implemented, tested on disposable databases |
| B. Migration 002: sources, batch/line/row identity, ownership checks | implemented; rehearsed by backup/restore (`docs/migration-runbook.md`); apply to the development database with the runbook |
| C. Overlap: reject (default) and explicit append | implemented |
| D. `replace_period` | deferred — needs its own reviewed design (replacement chains, partial coverage, rollback restoration) |
| E. Coverage (migration 003) | implemented: `backend/migrations/003_data_coverage.sql`, `backend/lib/coverage.js` |

## A. Versioned migrations

- **Files:** `backend/migrations/NNN_name.sql`, each applied in its own transaction.
  The runner is `backend/db/migrate.js`.
- **Recording:** `schema_migrations(version, name, checksum, applied_at)` stores each
  applied migration and the SHA-256 of its file. An applied file that has been edited
  blocks both migrating and startup.
- **`001_baseline.sql`:** exactly what `config/initDb.js` built up to `f0ce988`, made
  idempotent. On an existing database it changes nothing; it is only recorded.
- **Startup never runs DDL.** `server.js` calls `assertSchemaCurrent()` and refuses to
  start if migrations are pending or files were edited. A restart therefore can't
  undo a migration — for example, by re-adding the old uniqueness constraint, which
  `initDb.js` step 3 used to do on every start.
- **Applying is explicit:** `npm run migrate`, or `node config/initDb.js`, which now
  does the same.
- **Status and reversal:** `npm run migrate:status`; `node db/migrate.js down 2`
  reverses the latest migration. Only the latest can be reversed.

## B. Migration 002 — identity

| Layer | Identity | Behaviour |
|---|---|---|
| Batch (import operation) | `data_uploads (uploaded_by, idempotency_key)` | Key = explicit operation id (`client:<import_id>` for API imports, `file-op:<operation_id>` for files), otherwise a content fingerprint (`payload:<sha256>` / `file-content:<sha256>`). Same key + same content → original result, `replayed: true`. Same key + different content → `409`. |
| Line (when the source sends line ids) | `sales (source_id, source_line_id)`, unique | Same id + same contents → skipped (counted in `skipped` / `duplicates_skipped`). Same id + **different** contents → `409 line_conflict` and **nothing** from that import is written. Also applies to a line id repeated inside one batch. |
| Row | `sales (upload_id, source_row_number)`, unique | Every row of an import is distinct, so genuine identical orders are kept. The row number is the original data-row number, preserved through cleaning and validation, and stored on anomalies too. |

**Both duplicate-removal layers are replaced:**

- the database rule `unique_sale_transaction (product_id, sale_date, quantity, revenue)`
  is dropped;
- `removeDuplicates()` (content-based, in `routes/data.js`) is removed.

**Rollback keeps the identity.**
- A rolled-back import stays in `data_uploads` with `status = 'rolled_back'` and its
  key. A delayed retry receives the original result with `rolled_back: true`, and
  nothing is restored.
- A deliberate re-import needs a **new operation id**. File fingerprints identify
  content only: an explicitly new `operation_id` is always a new operation, and the
  overlap rules then apply to it.

**Sources.** `data_sources` holds one `file` source per seller and one `api` source
per connected store (`provider`, `external_store_id`). Each source has an IANA
`timezone`.

**Ownership consistency:**

- composite FK `data_uploads (source_id, uploaded_by) → data_sources (id, seller_id)`;
- triggers on `sales` (import seller = product owner; row source = import source) and
  on `products` (an import-created product belongs to the importer).

These checks apply to new or changed rows. Legacy conflicting rows stay quarantined
by `attributed_sales`.

**Concurrency.**
- Every import and rollback transaction takes `pg_advisory_xact_lock(7401, seller_id)`,
  so a seller's file uploads, store-connect imports and rollbacks are serialised.
- `upload_versions (seller_id, version_number)` is unique as a backstop.
- The replay path reuses the connection it already holds, so it works on a
  one-connection pool.

**Freshness** is recomputed inside the same transaction after every successful
import and rollback:

- `last_upload_at` = the latest **committed** import;
- totals and the last sale date come from `attributed_sales`.

## Business dates

- **What a sale date is:** a business-local calendar day in the source's timezone.
- **Accepted formats:**
  - `YYYY-MM-DD` → that day;
  - `YYYY-MM-DD HH:MM[:SS]` → local business time, so its calendar day;
  - ISO timestamp with `Z` or `±HH:MM` → converted to the source timezone's day;
  - Excel serial numbers (date cells in `.xlsx`) → that day.
- **Rejected as `invalid_date`:** anything else, including `01/02/2026`. Day and
  month order is ambiguous, and the old code silently read it as US order.
- **Future dates:** "future" means after today **in the source timezone**.
- **API output:** DATE columns are returned as `YYYY-MM-DD` strings. The pg default
  shifted them by a day on servers east of UTC.
- **Default timezone (decided 2026-10):** new sources default to `Asia/Karachi`
  (override with `DEFAULT_BUSINESS_TIMEZONE`). Each source keeps its own timezone
  (`PATCH /api/data/sources/:id`, or `connection.timezone`) and a change applies
  to future imports only. Sources backfilled by 002 stay `UTC`; stored dates are
  never reinterpreted.

## C. Overlap

Overlap applies only to rows **without line ids**, checked against existing rows of the
**same source** on the same (product, date):

- **`reject` (default):** `409 overlap_requires_choice`, listing up to 20
  product/dates. Nothing is written, and the claimed identity is released with the
  transaction.
- **`append`:** the import states that these are additional sales. This is recorded on
  the import (`data_uploads.overlap_mode`).
- The upload page sends a new `operation_id` per upload click. On `409` it offers
  **Cancel** or **Add as extra sales** (same operation, `overlap_mode=append`).

## D. Deferred: `replace_period`

Not implemented. A separate design must first cover:

- chains of replacements;
- partial coverage;
- restoring superseded rows when a replacing import is rolled back.

## E. Coverage (migration 003 — implemented)

- **Schema:** `data_coverage` and `data_coverage_products`, with composite ownership
  keys (source, import and products all belong to the declaring seller). There is one
  declaration per import, with status `confirmed` or `revoked`. `attributed_sales`
  gains a `source_id` column.
- **Declaring:**
  - File uploads send `coverage_start`, `coverage_end`, `coverage_scope`
    (`all_products` | `listed_products`) and `coverage_confirmed=true`.
  - Store connect sends `coverage: { start, end, scope, confirmed: true }`;
    its evidence is recorded as `connector_full_export`.
  - The declaration is part of the import fingerprint.
- **Checks before anything is written:**
  - the period is valid and ends no later than today in the source timezone;
  - the seller explicitly confirmed it;
  - no row was rejected;
  - every row is inside the period;
  - no earlier sales or confirmed period of the same source overlap it for the
    same products (`409 coverage_overlaps_existing_data`).
- **Zero-transaction imports:** with `all_products` coverage, an empty file or empty
  `sales` array is valid. It creates an import record and a version with 0 rows.
- **Later imports:** rows without line ids that fall inside a confirmed period of the
  same source are refused like overlaps, unless `overlap_mode=append`.
- **Revocation:** rollback revokes the import's coverage in the same transaction.
  Revoked periods are ignored.
- **Resolution (`productHistory`):** each day from the product's first sale onward is
  one of:
  - `covered` — inside confirmed coverage of **every** source that has sold the
    product; days without rows are 0;
  - `recorded` — not fully covered, but rows exist. The rows are taken as that
    day's sales, which is how all data worked before 003;
  - `unknown` — neither. It is never filled with zero.

  The usable history is the run of known days that ends on the last known day.
  Gaps are reported.

## Rollback strategy for migration 002

1. **Before applying:** `pg_dump -Fc nexuscommerce > pre_002.dump`, and verify that it
   restores into a scratch database.
2. **Rehearse:** apply on a restored copy first (`npm run migrate`), then run the test
   suite against it.
3. **Preferred rollback:** restore `pre_002.dump`. Imports made after the migration
   are lost and must be redone.
4. **Alternative:** `node db/migrate.js down 2` runs `002_import_identity.down.sql` in
   one transaction.
   - **It refuses and changes nothing** if genuine identical rows exist that the
     legacy rule would reject.
   - **It keeps** every sale, product and import record.
   - **It drops** sources, line ids, row numbers, import status and fingerprints.
   - After it, the server refuses to start until `npm run migrate` is run again, or
     the code is switched back to `main`.
5. **Code:** the migration and the code that depends on it ship together on this
   branch. `main` stays on the old schema until the merge is approved.

## Tests (backend, `npm test`)

- **`identity.test.js`:**
  - identical rows kept, with row numbers;
  - operation-id replay and conflict;
  - a new operation that overlaps → `409`, then `append`;
  - rollback keeps identity, for both files and API imports;
  - line ids: skip, conflict, within-batch conflict, scoped per connection and per
    seller;
  - `line_id` column in files;
  - Excel serial dates;
  - ambiguous dates rejected;
  - timezone conversion;
  - overlap only within the same source;
  - concurrent mixed file / API / rollback operations: versions unique and
    contiguous;
  - freshness after imports and rollbacks.
- **`upgrade.test.js`** (disposable database):
  - a database built the old way with legacy data upgrades with no row loss;
  - the quarantine is unchanged;
  - sources are backfilled, and identity and rollback state are kept;
  - after 002, identical rows are allowed and provenance violations refused;
  - restarting is a no-op and can't undo the migration;
  - reversal refuses with genuine identical rows, works after they're cleaned, and
    can be re-applied;
  - an edited migration file blocks both migrate and startup.
- **`pool.test.js`:** one-connection pool, replay and saturation.
- **Former TODOs, now passing:**
  - identical genuine orders in one import;
  - a file without revenue sent again (replayed, not duplicated).
