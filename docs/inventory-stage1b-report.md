# Inventory AI — Stage 1b report (for architect review)

Stage 1b covers suppliers, purchase orders, receipts, corrections, supplier returns, cancellation and incoming stock. It is built on branch `feature/inventory-stage1a`, after the Stage 1a checkpoint commit `e6a208e`. These changes are **uncommitted**, as the user asked.

Unchanged: forecasting models, routing, manual training (still disabled), and ownership repair (still dry-run). The Stage 1a stock rules are also unchanged. The only ledger change is three new movement kinds that purchasing writes.

## 0. Review corrections, round 1 (2026-10-08)

| Finding | Fix |
|---|---|
| A sales-upload rollback could delete, or fail on, products that purchasing refers to | The orphan cleanup now also keeps products that have supplier terms or purchase-order lines, alongside counts, movements, settings and legacy rows (`routes/data.js`). Regression test: a rolled-back upload keeps a supplier-linked product and a product on an unreceived order (whose terms row was removed, so only the order line refers to it). It deletes only the product nothing refers to, and the order stays intact. |
| Corrections and returns ignored `version`, and a correction on a cancelled order did not advance it | `version` is checked when sent: 409 `version_conflict` if stale, 400 if malformed, and nothing is recorded. The check runs after the replay check, so a valid replay returns the original result unchanged and never advances the version, even with its now-old version. Every new adjustment advances the version exactly once, including a correction on a cancelled order, where the status stays `cancelled`. Regression test covers corrections and returns, stale and missing versions, replays, and the cancelled case. |

Both regression tests fail on the previous code and pass now. Backend: **135/135** in UTC, Los Angeles and Tokyo. The stock rules, the migration and the forecasting models are unchanged.

## 1. Rules and where they are enforced

| Rule | Enforcement |
|---|---|
| Approval and ordering never change stock | Only `POST …/receipts` writes stock: one `receipt` movement (+qty) per receipt line, effective at `received_at`. In the browser run, approve and mark-ordered left the movement count unchanged and on-hand at 55, while incoming went from "approved, not sent 30" to "incoming 30". |
| A later physical count stays authoritative | Receipts are ordinary ledger movements, so the Stage 1a cutoff applies. A receipt before a count is inside it. A **correction** is written at the *receipt's* instant, so a count taken after the receipt still decides (tests, and browser step 13: count 70, then a correction of an earlier receipt, on-hand still 70). |
| Receipt replay cannot add stock twice | Receipt identity is `(seller, idempotency_key)` plus a content hash. A replay returns the original receipt and its movement ids and writes nothing; the same id with different content returns 409. A unique index allows exactly one movement per receipt line and per adjustment. Two identical receipts sent at the same time produce one receipt and one movement (test). |
| Partial corrections affect only the corrected quantity | A correction of N on a receipt line writes −N, reduces received by N, and reopens only N on the order line (received → partially received). Returns are separate: −N at the return time, received unchanged. Corrections plus returns can never exceed the receipt line's quantity (409 `exceeds_received`). Never revoke-and-subtract. |
| Cancelling preserves received goods; a cancelled order never reopens | Cancel closes only the remaining quantity (`quantity_cancelled`). Received stock stays. On a cancelled order: no receipts, no transitions, no arrival edits (409). A later correction adjusts received only, and the remaining quantity stays 0. |
| Seller ownership | Every route uses the seller from the token, and other sellers' ids return 404. Composite foreign keys `(id, seller_id)` run through supplier → terms → order → line → receipt → adjustment → movement, so even direct SQL cannot mix sellers. |
| Concurrent updates | Each order has a `version`. Edits and transitions require it (`If-Match` header or `version` field); a missing version gets 428, a stale one 409 `version_conflict`. Updates use `WHERE version = $expected`, and every write also holds the per-seller advisory lock. |
| Currency (D9) | A unit cost always carries its own currency; a cost without one is refused, never assumed. Each order has one currency, with the supplier default (PKR, editable) as the starting value. A line whose cost is in a different currency blocks approval (`currency_mismatch`, no conversion). Unknown costs need explicit acceptance at approval. |
| Pack size and minimum order (D5) | Checked at approval against the terms copied onto the line, with clear messages ("Packs of 10: order 20 or 30") and no rounding. The UI warns while the seller types. |
| Over-receipt (D4) | Receiving more than remains returns 409 `over_receipt` and records nothing. An order that is approved or placed can change only its expected arrival (409 `not_editable` otherwise). |
| Durable history | `purchase_order_events` is append-only: a database trigger refuses UPDATE and DELETE. It records creation, edits, approval, ordering, receipts (with stock effects), corrections, returns, status changes, cancellation, and each expected-arrival revision with from, to and reason. Receipts, receipt lines and adjustments are append-only too. |
| Incoming vs on-hand | `GET /inventory/items` reports `inbound` separately: open quantity, approved-not-sent, next expected date, overdue and no-date quantities. It also reports readiness dimensions for inbound (`none`, `approved_not_sent`, `open`, `no_expected_date`, `overdue`) and supplier (`none`, `missing_lead_time`, `missing_cost`, `complete`). On-hand never includes incoming. |

## 2. Migration 005

`005_suppliers_purchasing.sql` creates:

- tables: `suppliers`, `product_suppliers` (one active preferred supplier per product), `purchase_orders` (version, status CHECKs tied to timestamps, cancel reason), `purchase_order_lines` (copied terms), `purchase_receipts`, `purchase_receipt_lines`, `purchase_receipt_adjustments` (`correction` or `supplier_return`) and `purchase_order_events`;
- append-only triggers;
- the view `purchase_order_line_quantities`, where received is net of corrections, returned is separate, and remaining is always 0 on a cancelled order.

On `stock_movements` it:

- adds the kinds `receipt` (+), `receipt_correction` (−) and `supplier_return` (−);
- adds link columns, with CHECKs that purchasing movements always point at their receipt line or adjustment and that nothing else can use these kinds;
- adds one-movement-per-line unique indexes.

`005 down` refuses, changing nothing, once any purchasing data exists. Otherwise it restores the exact 004 constraints.

## 3. API

| Area | Routes |
|---|---|
| Suppliers | `GET`/`POST /api/suppliers`, `GET`/`PATCH /api/suppliers/:id` |
| Product–supplier terms | `GET /api/products/:id/suppliers`, `PUT`/`DELETE /api/products/:id/suppliers/:supplierId`. DELETE deactivates the terms; existing orders keep their copied terms. |
| Purchase orders | `GET /api/purchase-orders?status=` (`open`, or one status), `GET /:id` (lines, receipts, adjustments, events), `POST` (draft; replay-safe), `PATCH /:id` |
| Transitions | `POST /:id/approve`, `/mark-ordered`, `/cancel` (reason required) |
| Receiving | `POST /:id/receipts`, `POST /:id/receipts/:receiptId/corrections`, `POST /:id/receipts/:receiptId/returns` |

Every change returns `{ purchase_order, stock_effects: [{ product_id, movement_id, kind, quantity, effective_at }] }`.

## 4. Tests

| Suite | Result |
|---|---|
| Backend, `TZ=UTC` | 135/135 (Stage 1a: 117) |
| Backend, `TZ=America/Los_Angeles` | 135/135 |
| Backend, `TZ=Asia/Tokyo` | 135/135 |
| ML | 23/23 (models unchanged) |

New `test/purchasing.test.js` (13 tests, including the 2 regression tests in §0) covers:

- supplier and terms validation;
- the currency never being assumed;
- one preferred supplier per product;
- the full lifecycle, with approval changing no stock;
- the pack-size rejection message;
- receipt replay, concurrent duplicates, conflicting ids and over-receipt;
- a later count staying authoritative over a receipt and a correction, with returns applying when they happen;
- the correction/return cap and refusing a return dated before its receipt;
- a correction without a later count reducing stock once, with replay;
- cancelling after a partial receipt: stock kept, never reopened, no edits, a correction leaving remaining at 0;
- version required, stale version refused, non-draft edits refused, arrival history;
- append-only triggers;
- currency mismatch, unknown costs and missing terms;
- draft replay;
- overdue incoming separate from on-hand;
- seller isolation on 12 routes, plus composite foreign keys;
- manual movements unable to impersonate purchasing.

New `test/upgrade005.test.js` (5 tests): 005 applies on a 004 database with recorded inventory and leaves the ledger unchanged; constraints hold; reversal restores the 004 rules; reversal refuses once a supplier exists.

## 5. Migration evidence

- **Rehearsal** on the demo database at 004 (7 counts, 4 movements, −10 movement units, 6 settings, 1,683 sales): **passed**. Every count, ledger included, was unchanged (`rehearsal_005.txt`).
- `npm run migrate` then applied 005 to the demo database (`migrate_005_demo_db.txt`).
- **Not done yet:** the Windows development database is still at 004. Run the runbook steps for 005 locally.

## 6. Browser demonstration (real pages, real backend and PostgreSQL)

Evidence is in `docs/evidence/inventory-stage1b/`. Numbers come from the API after each step (`browser_api_evidence.json`).

| Step | Result | Screenshots |
|---|---|---|
| Suppliers | Two suppliers. Lawn Suit (PKR 2,800, 10 days, min 20, pack 10) and Prayer Mat (PKR 900, 7 days, min 12, pack 6). Mug linked with no cost and no lead time, shown as "Cost not set" and "Lead time not set", with mug readiness `missing_lead_time`. | 01–03 |
| Draft | 25 Lawn Suits shows "Packs of 10: 20 or 30. Approval will be refused until fixed"; corrected to 30, plus 12 mats, arriving in 5 days. | 04, 05 |
| Approve → ordered | Movements unchanged and Lawn on-hand still 55. Incoming: approved, not sent 30, then incoming 30 due on the date. The stock tab shows the "Incoming" column separate from on-hand. | 06, 07 |
| Partial receipt | 20 suits: partially received, on-hand 75, incoming 10. | 08 |
| Completion | 10 suits and 12 mats: received, `completed_at` set, Lawn 85, mats 12. A replay of the receipt id gave 200 `replayed`, with movements and stock unchanged. | 09 |
| Receipt correction | 2 mats recorded wrongly: received 10, corrected 2, remaining 2, status back to partially received. Mats 12 → 10 (no later count), movement −2 at the receipt time. | 10 |
| Supplier return | 3 suits sent back: Lawn 85 → 82 at the return time; received still 30, returned 3, remaining unchanged. | 11 |
| History and arrival revision | 11 durable events. The arrival change shows from → to with its reason. A stale version gave 409 `version_conflict`. | 12 |
| Overdue | A second order due 2 days ago shows "Overdue" in the list, and Lawn shows 20 overdue incoming. | 13 |
| Cancel after a partial receipt | Received 10 (Lawn 82 → 92), then cancelled the remainder with a reason: received 10, cancelled 10, remaining 0. Lawn stays at 92 with nothing incoming. Receiving afterwards gave 409 `not_receivable`; approving afterwards gave 409 `invalid_transition`. | 14 |
| Later count authoritative | Count 70, then a correction of an earlier receipt: on-hand stays 70. | — |
| Another seller | Order 404, receipt 404, empty supplier and order lists. | — |
| Final state | Stock tab and the Lawn ledger history with all purchase movements and their relation to the count. Mobile layouts. | 15–18 |

Console errors during the run: 0.

## 7. Judgement calls for review

1. **Correction timing.** A correction is written at the receipt's own instant. It therefore never overrides a later count, and with no later count it subtracts exactly the corrected units.
2. **A correction reopens the line.** This follows plan §10. A corrected order goes back from received to partially received, `completed_at` is cleared, and history keeps the earlier completion. On a cancelled order nothing reopens.
3. **Pack-size and minimum checks** use the terms copied when drafting (§3.2). Approval also requires the supplier link to be still active. Changing a link's terms later does not change existing orders; editing draft lines copies the current terms again.
4. **Receipt timestamps** are not restricted relative to `ordered_at`. Marking an order as ordered late should not block recording a real delivery. Receipts must not be in the future, and a return cannot be dated before its receipt.
5. **Versions on receipts.** Receipts, corrections and returns are protected by their idempotency key, the seller lock and quantity checks. A `version` is optional on these but checked whenever it is sent, after the replay check. Every new receipt or adjustment advances the version once. Edits and transitions require a version.
6. **UI scope.** The Suppliers and Purchase orders tabs are inside Inventory, in the existing components and colours. Layout-only CSS was added for the order timeline.
