# Import identity, line identity and data coverage — proposal

Status: **proposal for architect review**. Part A is live. Parts B–E are the proposed
migration `backend/migrations/proposed/002_import_identity_and_coverage.sql`, which is
**not applied** and is not loaded by any code.

## Problem

1. **Retries duplicate sales.** The only protection was the legacy constraint
   `UNIQUE (product_id, sale_date, quantity, revenue)`. PostgreSQL treats NULLs as
   distinct, so rows without revenue were inserted again on every retry.
2. **Genuine sales are merged.** The same constraint merges two real orders with the
   same product, day, quantity and revenue, so daily totals come out too low.
3. **File dates are not proof of coverage.** A file's first and last transaction
   dates do not prove that every day in between is present. Zero-filling a range
   that is only *observed*, not *confirmed*, invents zero-sale days.

## A. Live now (initDb.js step 5 + `routes/store.js`)

- Every `/api/store/connect` call is one **import record** in `data_uploads`
  (`source = 'store_connect'`). It gets an upload version, and every sale and every
  product it creates carries `upload_id`. It can be rolled back like a file upload.
- **Identity:** the client's `import_id`, otherwise the SHA-256 of the canonical
  payload (keys sorted). The record is claimed with
  `INSERT … ON CONFLICT (uploaded_by, idempotency_key) DO NOTHING` **inside the same
  transaction** as the data. A concurrent retry waits on the unique index, then
  returns the committed original.
- **Responses:**
  - retry → `200 {…original result, replayed: true, rolled_back}`;
  - same `import_id` with different data → `409 import_id_conflict`.
- **Still to do:** the legacy constraint is still in place, so identical genuine
  rows are still merged. This is a known test marked `todo`.

## B. Line identity (proposed)

| Source | Identity of a sale row | Prevents replay by |
|---|---|---|
| API with line ids | `(connection_id, source_line_id)`, unique | the line id itself, across batches |
| API without line ids | `(upload_id, source_row_number)` | the import identity of the batch |
| File | `(upload_id, source_row_number)` | file identity `file:<sha256>` |

- **Order IDs are not used:** one order can have several lines, so `source_line_id`
  must identify the line, not the order.
- **Identical genuine rows are kept:** they get different row numbers.
- **The legacy constraint goes:** it is dropped in the same release in which both
  import paths write line identity. In that release:
  - `initDb.js` step 3, which re-adds the constraint on every start, must be removed;
  - the `attributed_sales` definition must move from `initDb.js` to the migration.
- **Rollback releases the identity** (`idempotency_key := NULL`), so the same file or
  `import_id` can be imported again deliberately.

## C. Overlapping files without line ids (proposed)

The rows can't be matched to earlier rows, so the seller must choose. The upload
takes `overlap_mode`:

- `reject` (default): `409` with the overlapping products and dates. Nothing is
  written.
- `append`: the seller states these are additional sales.
- `replace_period`: the seller states this file supersedes earlier rows for the same
  products and dates. Earlier rows get `superseded_by_upload_id`; they are hidden by
  `attributed_sales`, not deleted. Rolling back the replacing import clears the flag.

Overlap is detected against active imports of the same seller, while holding
`pg_advisory_xact_lock(seller_id)`.

## D. Coverage (proposed)

`data_coverage` records, per import or per connection:

- `observed_start` / `observed_end`: informational only;
- `declared_start` / `declared_end`;
- `scope`: `all_products`, or `listed_products` (with `data_coverage_products`);
- `status`: `unconfirmed`, `confirmed` or `revoked`;
- `evidence`: `seller_declaration` or `connector_full_export`, plus a note;
- who declared it and when, and who revoked it, when and why
  (`rollback`, `seller_revoked` or `superseded`).

**Resolution rules (used by v2 later):**

- A product's covered days are the union of its seller's **confirmed**, non-revoked
  periods that apply to it, starting no earlier than its first known sale.
- **Inside** coverage, a day without sales is 0. **Outside** coverage the day is
  unknown, never zero.
- A rollback revokes the import's coverage in the same transaction.
- Repeated imports: confirmed periods are merged.
- Existing uploads are backfilled as `unconfirmed`, with observed dates only.

## E. API contract (proposed)

`POST /api/store/connect`:

```
{ import_id?, connection?: {provider, external_store_id, display_name?},
  products: [...],
  sales: [{product_name, quantity, sale_date, revenue?, line_id?}],
  coverage?: {start, end, scope, product_names?, confirmed: true, evidence_note?} }
```

The response adds `connection_id` and `lines_without_id`.

`POST /api/data/upload` (multipart), optional fields:

- `overlap_mode`: `reject` | `append` | `replace_period`
- `coverage_start`, `coverage_end`, `coverage_scope`, `coverage_confirmed=true`

Responses:

- `200` → normal result;
- `200 {replayed: true}` → identical file already imported;
- `409 overlap_requires_choice` → `{overlaps: [{product, start, end, existing_upload_ids}]}`.

Coverage endpoints:

- `PUT /api/data/uploads/:id/coverage` → `{start, end, scope, product_ids?, evidence_note?}`.
  Owner only; the import must not be rolled back. Returns `200`, `400` or `404`.
- `DELETE /api/data/uploads/:id/coverage` → status becomes `revoked`
  (`seller_revoked`).
- `GET /api/data/coverage?product_id=` →
  `{confirmed_periods: [{start, end, upload_ids}], unknown_gaps: [{start, end}], latest_confirmed_date, contiguous_days_to_latest}`.

## F. Tests required with the migration

- Null revenue: retry, and identical genuine rows.
- Identical genuine orders in one batch and in one file: both kept.
- Retries: same `import_id`, payload-derived identity, and replay of the same file.
- Concurrent retries (3 in parallel): exactly one import, one version and N rows.
- The same `line_id` in two batches of one connection: stored once. The same
  `line_id` in another seller's connection: allowed.
- Overlap modes: `reject` writes nothing; `append` adds rows; `replace_period`
  supersedes, and rolling back the replacing import restores the earlier rows.
- Rollback releases the identity and revokes coverage.
- Coverage: zero-fill only inside confirmed periods; unknown gaps reported;
  `listed_products` scope respected; revoked periods ignored.
- `initDb.js` restart after the migration: no constraint re-added, and the view
  definition is unchanged.

## G. Migration order

1. `pg_dump -Fc`.
2. Ownership repair reviewed, or explicitly deferred.
3. Release the code and apply 002 together.
4. Run the full test suite against a restored copy first.

**Rollback:** restore the dump. The manual DOWN steps are in the SQL file, but once
identical genuine rows exist they can't re-add the legacy constraint.
