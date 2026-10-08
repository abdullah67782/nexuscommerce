# Inventory AI — Stage 1a report (for architect review)

Branch `feature/inventory-stage1a` (from `main` at `e6d20ee`). Scope is exactly Stage 1a:
stock ledger, legacy migration, readiness, inventory UI states and the shipment API.
Stage 1b (suppliers, purchase orders, receipts) has not been started.
The forecasting models (`nexus-v2-shared-20261008`), the routing rule, manual training
(still disabled) and the ownership repair (still dry-run) are unchanged.

## 1. Accounting rules as implemented

`on_hand = selected count + Σ movements effective strictly after it`. This is computed at read time
(`backend/lib/stockLedger.js → positions`) and is never stored.

| Review requirement | Implementation |
|---|---|
| **1. Snapshot selection** | The selected count is the **active, verified** count with the latest `observed_at`. Unverified legacy values have no time, so they can never be selected and never enter the arithmetic. A partial unique index allows only one active count per seller/product/location/instant. The same value at the same instant is `already_recorded` and creates no new row. A different value returns 409 `conflicting_count` and writes nothing, unless the request sends `supersede: true`: the old count is then marked `superseded_by` the new one. Insertion order is never used. A connector can submit counts only if its source is declared `reports_physical_on_hand` for the location (`PUT /inventory/sources/:id`); a channel's "available" quantity is refused (422). A replay with the same id and content returns the original result; the same id with different content returns 409. |
| **2. Count age vs completeness** | Returned separately. `last_count.observed_at` and `age_days` give the age. `movement_tracking` is `complete`, `partial`, `absent` or `not_applicable`, alongside `events_since_count` and `untracked_sales_since_count`. **Complete** requires a source declared to send every shipment for the location since a time at or before the count, and no sales from any other source on or after the count's business date (location timezone). Otherwise tracking is `partial`, or `absent` when no feed exists. `position_type` is `tracked` only when tracking is complete; otherwise it is `last_known`. A count from an hour ago with no feed is still `last_known`. |
| **3. Stable, auditable ledger** | Movements are append-only. Their relation to the count (`before_count_included`, `at_count_included`, `after_count`, `no_count`) is computed at read time against the currently selected count. A count includes events at its exact instant (`effective_at <= observed_at`). An event at exactly the count instant from any source other than the connector that reported the count is flagged `reconciliation: needs_review`. Movements recorded with no count are kept and also flagged. Instants must carry an offset; local or date-only times are refused, never guessed. |
| **4. Rollback** | Sales rollback deletes only products created by that import that have no sales **and** no counts, movements, settings or legacy inventory rows. Foreign keys from the ledger to `products (id, user_id)` also block deletion. A stock-count file is its own import kind (`data_uploads.source = 'stock_count'`): rollback revokes its counts (kept as evidence), counts it had superseded become active again, and no sales or products are touched. Count files cannot be confirmed as sales coverage (400), never move sales freshness, and are excluded from data-quality figures. |
| **5. Constraints** | The seller default policy is unique through a partial index (`product_id IS NULL`), as are product policies. Each product/location appears once per submission (`UNIQUE (batch_id, product_id, location_id)`). The API refuses duplicate products, and a count file rejects conflicting duplicate rows (identical duplicates are collapsed and reported). Every legacy row is kept in `inventory_legacy_rows` with an outcome: `migrated`, `duplicate_not_selected`, `ownerless_not_migrated`, `missing_product` or `negative_not_migrated`. The legacy `inventory` table is not modified. `004 down` **refuses and changes nothing** once any count, movement, seller setting, source mapping or stock-count import exists; the preservation path is the pre-migration backup (runbook). |

Also implemented:

- **D1:** sales files never write stock. The upload response carries `stock_columns_ignored` and the UI shows the notice with a link to Inventory.
- **D2:** legacy values become unverified observations. The original `updated_at` is shown as a server-clock write time, never as a count time.
- **D6:** stale defaults to 7 days, editable per seller and per product. The UI states that it is not evidence of accuracy.
- **D7:** commitments are reported as `not_tracked`, and on-hand is labelled "not available-to-sell".
- **D8:** the shipment API has per-event identity, replay protection and a conflicting replay refusing the whole request.
- **D10:** demo stock comes only from `backend/scripts/demo-inventory-data.js`, which uses the API and refuses `NODE_ENV=production`.

## 2. API (`/api/inventory`, all authenticated; another seller's id → 404)

| Route | Purpose |
|---|---|
| `GET /items?page&page_size&state&q` | Paginated items. Counts cover all products. |
| `GET /items/:id` | Item, count history, movements with relation, legacy evidence |
| `POST /snapshots` | Count form or connector counts |
| `POST /snapshots/:batchId/revoke` | Revoke a count submission |
| `POST /count-files` | Multipart stock-count file, plus `counted_at`, `operation_id` and `supersede` |
| `POST /movements` | Manual adjustment (damage, found, customer_return, correction, with a reason), or connector `events[]` (shipment, customer_return) |
| `GET`/`PATCH /policy`, `GET`/`PATCH /items/:id/policy` | Threshold and stale tolerance |
| `GET`/`PUT /sources/:id` | What a source reports (physical on-hand; shipment feed since) |
| `GET /alerts` | Same array shape; adds `product_id`, `category` and position fields. Unknown stock is returned as `risk_level: 'unknown'`. |

Other API changes:

- `/api/products` no longer returns `stock_level` or `reorder_threshold`. The old values were defaults: 0 when stock was unknown, 10 when no threshold was set.
- The old `/api/inventory/alerts` in `data.js` was replaced.

## 3. Files

| Area | Files |
|---|---|
| Migration | `backend/migrations/004_inventory_ledger.sql`, `004_inventory_ledger.down.sql` |
| Backend (new) | `lib/stockLedger.js`, `lib/inventoryReadiness.js`, `routes/inventory.js`, `lib/files.js` (upload parsing moved out of `routes/data.js`) |
| Backend (changed) | `app.js` (mount), `routes/data.js` (D1 notice, rollback, `/products`, quality), `lib/imports.js` (freshness excludes count files), `lib/coverage.js` (refuses count files), `scripts/rehearse-migration.js` (inventory checks) |
| Tests | new `test/inventory.test.js` (13 tests), `test/upgrade004.test.js` (8 tests); updated `access`, `rollback`, `upgrade`, `helpers` |
| Frontend | `app/inventory/page.jsx` (rewritten, no mocks), `app/dashboard/page.jsx` (unknown stock separate, error state), `app/upload/page.jsx` (notice, stock-count versions, columns/sample without stock), `components/Dialog.jsx` (`wide`), `styles/workspace.css` (layout only, existing tokens) |
| Scripts / docs | `scripts/demo-inventory-data.js`, `docs/migration-runbook.md`, `docs/inventory-stage1-plan.md` §10 (Stage 1b decisions), this report |

## 4. Test results

| Suite | Result |
|---|---|
| Backend, `TZ=UTC` | 113/113 (previously 92) |
| Backend, `TZ=America/Los_Angeles` | 113/113 |
| Backend, `TZ=Asia/Tokyo` | 113/113 |
| ML (`ml/tests`) | 23/23, unchanged |

Logs are in `docs/evidence/inventory-stage1a/`.

New tests cover:

- missing stock vs measured zero vs unverified legacy;
- count → shipment → newer count, and revoking it;
- same-instant events;
- shipment replay and conflicting replay (including inside one request);
- count identity: replay, already recorded, conflict, supersede and its undo;
- sales uploads with stock columns;
- seller isolation on every route;
- movement tracking absent → complete → partial;
- stale and inconsistent states, and per-product tolerance;
- adjustment signs, reasons and refused kinds;
- count validation (offsets, future, negative, fractional, duplicates, physical-stock sources, unmapped source);
- count files (rejected rows, version, rollback, freshness, coverage refusal);
- sales rollback keeping products that have stock facts;
- 004 on an old-style database: every outcome, values preserved, constraints, reversal while only migrated values exist, and refusal with nothing changed after a count, a movement or a seller setting.

## 5. Migration evidence

| Rehearsal | Rows | Outcome | Evidence |
|---|---|---|---|
| Old-style database at 003 | 34 legacy rows, 1,800 sales | 34 rows kept as evidence: 29 migrated (827 units), 2 duplicates not selected, 2 ownerless, 1 negative not migrated. Users, products, sales (rows and units), imports, attributed sales, versions and the legacy table are unchanged. | `rehearsal_old_style_db.txt` |
| Demo database before migrating | 3 legacy rows | 3 migrated, 117 units; all counts unchanged. Then `npm run migrate` applied 004. | `rehearsal_demo_db.txt`, `migrate_demo_db.txt` |

**Not yet done:** your Windows development database is not reachable from here. Run the runbook steps for 004 locally before merging.

## 6. Browser demonstration (real pages, real backend and PostgreSQL)

The demo seller's database was migrated, then seeded with `demo-inventory-data.js`. Running the script a second time replayed everything, with no new rows. Numbers are taken from the API after each step (`browser_api_evidence.json`).

| # | Acceptance case | Result | Screenshots |
|---|---|---|---|
| 1 | Missing, measured zero and unverified legacy are distinct | Pashmina Shawl: "— no count, old value 12, unverified", state `unverified_only`, overall blocked. Prayer Mat: **0**, a counted zero, below threshold. Silk Dupatta: "— no count", `missing`. | 01, 18, 09 |
| 2 | Count → shipment → newer count, no double deduction | Lawn Suit: count 64, shipments −3 −2 −4 gives 55 (tracked). A newer UI count of 54 gives **54** (not 45); the three shipments show "before the count — inside the count". | 02, 03, 04 |
| 3 | Rolling back the newer count recomputes | After a later shipment of −4 (50), revoking the newer count in History gives **51** = 64 − 9 − 4. | 05a, 05b |
| 4 | Replay changes nothing; conflicting replay refused | Replay: 200, recorded 0, replayed 1, on-hand still 50. A conflicting replay plus a new event: 409 `event_conflict`; the new event was not recorded and the tables were unchanged. A same-instant count conflict prompts for explicit replacement (6 superseded by 5). | 06, 07 |
| 5 | Historical sales uploads leave inventory unchanged | A sales CSV with `stock_level` and `reorder_threshold` shows the "Stock columns ignored" notice. Snapshot, movement and legacy-table counts and every on-hand figure are identical before and after. Ceramic Mug's tracking changed `complete` → `partial`, because new mug sales came from a source without shipments; its on-hand is unchanged. | 08, 09 |
| 6 | Another seller cannot read or modify | Item, policy, revoke, movement, shipment and source: 404. Counts by A's id or name: 400 `product_not_found`. B's lists are empty and the tables are unchanged. B's page shows "No products yet". | 13 |
| 7 | Empty and failed API responses show real states | A simulated 500 on `/inventory/items` shows the error panel with Retry and no sample figures. A 500 on alerts shows a dashboard error panel ("does not mean stock is healthy"). The no-match filter and the empty seller are shown. | 14, 15, 16, 13 |
| 8 | Migration rehearsal preserves data | See §5. | text files |

Also shown:

- bulk count file (version #7: 2 recorded; "Ghost Item" not found; 2.5 is a fractional quantity), its "Stock count" row in Upload history, and its rollback (Silk Dupatta back to no count, Mug back to 21) (10, 11);
- dashboard listing unknown stock separately (12);
- mobile layout (17).

Console: the only errors are the expected 409 (conflict demonstration) and the simulated 500s.

## 7. Judgement calls to review

1. **Completeness rule.** Sales on the count's business date count as untracked even if they happened before the count time. This is conservative: the system cannot tell. A sales file uploaded later can turn `complete` into `partial` after the fact; this is intended.
2. **Same-instant events.** Treated as included, and flagged unless they come from the same connector that reported the count.
3. **Negative latest legacy row.** It is not migrated, and an older non-negative duplicate is not used in its place. Both rows are kept as evidence.
4. **One version sequence.** Count files share the import version sequence, so "only the latest import can be rolled back" applies across sales imports and count files.
5. **Revoke.** Any active count-form or connector count can be revoked, not only the latest. Revoking restores the count it superseded.
6. **Legacy thresholds.** These are copied with provenance `legacy_migration`. The old upload wrote 10 when a file had no threshold, and that cannot be told apart; the UI says so.
7. **Count-file rejected rows.** These are recorded as `warning` anomalies, not `critical` ones, because they do not affect sales or forecasts.
8. **Untouched on purpose.**
   - `seeder.js` still writes the legacy table; the app ignores it after 004.
   - `ownership_repair_dryrun.sql` still reads legacy `inventory`, which remains valid because the table is unchanged.
   - The pricing page's mock fallback is out of scope.

## 8. Stage 1b decisions recorded

These are in `docs/inventory-stage1-plan.md` §10:

- the two meanings of receipt reversal (correction vs physical return) and their effect on later counts;
- the cap on cumulative reversals;
- never revoking and subtracting the same receipt;
- remaining quantity and status after a reversal;
- cancelled orders never reopening;
- durable history of promised-arrival revisions and state transitions.
