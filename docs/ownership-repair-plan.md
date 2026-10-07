# Ownership repair plan (not executed)

## Background

Before seller isolation, file uploads matched existing products **by name only**.
As a result, seller B's sales could be attached to seller A's product, or to a
product with no owner. The same upload could also overwrite that product's price,
category and stock.

**What is live now:** these rows are **quarantined**. They stay in `sales` but are
excluded from every seller-facing read and from the ML server through the
`attributed_sales` view, which hides rows whose import was made by someone other
than the product owner. **Nothing has been moved or deleted.**

## Step 1 — Inventory and dry run (read-only, available now)

```
psql -d nexuscommerce -o repair_dryrun_YYYYMMDD.txt -f backend/scripts/ownership_repair_dryrun.sql
```

The script runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`. It reports:

1. **Summary:** all rows, attributed rows, conflicting rows, rows on ownerless
   products, and rows without an import record.
2. **Conflict groups:** product, current owner, importing seller, import, rows,
   units and dates.
3. **Dry-run mapping**, one line per (product, import). It proposes **moving the sale
   rows** to the importing seller's product of the same name, or creating one.
   Products themselves are never transferred. Each line also shows:
   - `mixed`: the product also has the owner's own rows;
   - `entirely_foreign`: all of the product's rows came from other sellers;
   - `ownerless`;
   - how many rows would collide with the legacy uniqueness rule in the target.
4. **Ambiguous records**, which need a human decision:
   - rows with no import record on affected products;
   - imports with no recorded seller;
   - ownerless products without provenance;
   - product price, category and stock that may have been overwritten (no history
     is stored, so this can't be reconstructed).
5. **Derived data:**
   - stored forecasts for affected products;
   - model metrics and training jobs of affected owners recorded after the first
     conflicting import;
   - freshness rows to recompute.

## Step 2 — Review (required before any write)

- **Decide each conflict group:** move, create the target product, or keep it
  quarantined.
- **Decide each ambiguous item.** Rows without provenance stay with the product
  owner unless there's other evidence.
- **Decide what happens to derived data:**
  - delete forecasts for affected products, or keep them marked as stale;
  - mark model metrics and personal models trained after contamination as
    *untrusted*. Model files are kept, not deleted.
- **Record the approved mapping as a reviewed CSV:**
  `sale_id_group, from_product, to_product | create, decided_by, decided_at`.

## Step 3 — Execution script (to be written after review; not written yet)

1. `pg_dump -Fc nexuscommerce > pre_repair_YYYYMMDD.dump`, and verify it restores
   into a scratch database.
2. Run everything in one transaction with `pg_advisory_lock` held and the API
   stopped.
3. Create a `repair_log(sale_id, from_product_id, to_product_id, created_product, decided_by, applied_at)`
   table.
4. Create the target products for the importing seller. Name and category are
   copied; price only if confirmed during review.
5. `UPDATE sales SET product_id = <target>` for the approved rows only, logging each
   row.
6. Collisions with the legacy constraint follow the per-row decision from the
   review: skip and keep quarantined, or merge.
7. Apply the derived-data decisions and recompute `data_freshness` for every affected
   seller.
8. **Verify inside the same transaction:**
   - the conflict query returns only the rows deliberately kept in quarantine;
   - row counts balance;
   - `attributed_sales` totals per seller match expectations.

   Only then commit.

## Step 4 — Rollback

- **Before commit:** roll the transaction back.
- **After commit:** reverse each row from `repair_log`
  (`UPDATE sales SET product_id = from_product_id`), then delete the products the
  repair created. Or restore `pre_repair_YYYYMMDD.dump`.

## Not covered

- Product fields that were overwritten (price, category, stock) can't be recovered
  automatically; they are listed for manual correction.
- Inventory is per product, not per seller import, so stock overwritten by another
  seller's file is flagged but not reconstructed.
