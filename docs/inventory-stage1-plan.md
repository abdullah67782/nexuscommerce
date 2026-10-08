# Inventory AI — Stage 1 plan: inventory data foundation

**Status:** proposed for architect review. No application code has been written.
**Baseline:** `main` at `e6d20ee`, with `docs/inventory-ai-architecture-proposal.md`.
**Scope:** proposal §11 step 1 only.

**Out of scope for Stage 1:**
- forecasts and forecast-linked planning;
- uncertainty or supplier models;
- the optimizer and simulator;
- the inventory assistant.

The forecasting models and routing stay unchanged.

**Initial boundaries:**
- one physical location;
- discrete integer quantities;
- one currency per purchase order;
- every purchase draft is approved by the seller.

---

## 1. Review: the proposal against the current code

### Confirmed gaps

The proposal's gap list is accurate, with these additions:

- **No ownership on stock.** `inventory` has no seller column. Ownership comes only from
  `products.user_id`.
- **Duplicate stock rows are possible.** There is no unique key on `product_id`, so a
  product can have more than one `inventory` row. Today's code reads "the" row with
  `SELECT id ... WHERE product_id`.
- **Missing stock looks like zero.** `stock_level INT NOT NULL`, and `/products` uses
  `COALESCE(stock_level, 0)`, so unknown stock cannot be represented and appears as 0.
- **`updated_at` is not a measurement time.** It records when the row was written, not
  when the stock was counted.
- **File uploads overwrite stock.** `POST /data/upload` overwrites `stock_level` and
  `reorder_threshold` from the last row that carries them. The value comes from file order
  and upload time, with no measurement time, inside a file whose rows are historical
  sales.
- **Rollback does not restore stock.** Rolling back an upload deletes inventory only
  for products that the upload created and that end up with no sales. Stock that the
  upload overwrote on an existing product is **not** restored. This is a correctness gap
  that Stage 1 removes.
- **Inventory alerts are capped and unstable.** `/inventory/alerts` stops at 10 rows,
  omits `product_id`/`category`, labels risk from the threshold only, and treats products
  without an inventory row as healthy (they are simply absent).
- **Sample data replaces real states.** The inventory page shows `MOCK_PRODUCTS` both
  when the response is empty and when the request fails.
- **The overview also depends on alerts.** `dashboard/page.jsx` builds its "needs your
  attention" items and risk table from `/inventory/alerts`.
- **Not Stage 1, but noted:** the pricing page has the same sample fallback, and calls
  `/pricing/recommendations`, which does not exist.
- **Store connect carries no stock.** Connector stock is a new contract (§4.4).

### Agreed with the proposal (implemented as written)

- A snapshot is an absolute observation; a movement is a signed delta.
- Physical, reserved and inbound stock are distinct.
- Historical sales uploads never decrement stock.
- Legacy stock becomes an *unverified* opening observation.
- Unknown stock is not zero.
- Seller ownership is enforced by constraints.
- Purchase approval stays deterministic and seller-driven.

### Proposed changes and narrowings, for review

1. **Commitments (reservations and backorders).** Define the table shape in this plan,
   but do not build it in Stage 1. No source of reservations exists yet. Readiness reports
   `commitments: not_tracked`, so any later plan is labelled provisional.
2. **Shipments.** Stage 1 adds the movement type and an idempotent event API with tests,
   so the no-double-deduction contract exists and is proven. No connector sends events
   yet.
3. **Split Stage 1 into two reviewable halves:**
   - **1a:** stock ledger, legacy migration, readiness, inventory UI states.
   - **1b:** suppliers, purchase orders, receipts.

   Each half is its own migration and commit set.

---

## 2. How stock stays consistent

### 2.1 Definition

For one product at one location:

```
latest_snapshot S = the active snapshot with the greatest (observed_at, id)
on_hand = S.quantity + Σ movement.quantity
          for active movements with effective_at > S.observed_at
```

- **No active snapshot:** `on_hand` is **unknown**, even if movements exist. Receipts
  alone do not tell us what was already on the shelf. The API still reports the
  movements, for example "received 40 since 3 Oct; no stock count yet".
- **Cutoff rule:** a snapshot taken at `T` already includes every physical event with
  `effective_at ≤ T`. A movement exactly at `T` counts as included.
- **Computed, not stored:** on-hand is calculated, never written as a mutable number,
  so there is no running total to drift. A per-product cache can be added later if
  performance needs it. The cache must be rebuilt from the ledger, never treated as
  the source of truth.

### 2.2 Each input

| Input | What it writes | Interaction |
|---|---|---|
| Historical sales upload (file or store connect) | Nothing to stock. Stock columns in a sales file are not written to stock (decision D1). | Cannot double-deduct, because it never deducts. |
| Stock count (form or stock-count file) | Snapshot with a seller-declared `observed_at`, `verified` | Replaces the position from `observed_at` onward. Earlier movements are subsumed. |
| Connector stock snapshot (API) | Snapshot with the connector's `observed_at` and `source_id` | Same rule. Snapshots from several channels at one location are **never summed**. The latest observation wins: a newer snapshot from channel B supersedes an older one from channel A at the same location. |
| Purchase receipt | Movement `receipt`, `+qty`, effective at `received_at` | Adds to on-hand only if received after the latest snapshot. If a later count at `T2 > received_at` arrives, the receipt is inside the count and is not added again. |
| Fulfillment / shipment event (API) | Movement `shipment`, `−qty`, unique `(source, external_event_id)` | Replaying the same event is a no-op. Same id with different content returns `409`. Events at or before the latest snapshot are stored but do not change on-hand. |
| Manual adjustment (damage, return to stock, found, correction) | Movement with a reason, a signed quantity and an idempotency key | Same cutoff rule. |
| Late event (`effective_at` before the latest snapshot) | Stored and marked `before_latest_count` | Excluded from on-hand. Kept for reconciliation and later anomaly checks. |

### 2.3 Rollback and corrections

- **Rolling back a stock-count import** (it is a normal import version) marks its
  snapshots `revoked`. On-hand is recomputed from the previous snapshot. That snapshot is
  older and is shown with its own date, so readiness reports `stale` or "needs a count".
  Nothing is restored silently.
- **Rolling back a sales import** never touches stock, because sales never wrote stock.
- **Receipts are never deleted.** A mistaken receipt is corrected by a linked
  `receipt_reversal` movement: negative, with `reversal_of` set, and at most the received
  quantity. It reopens that quantity on the purchase-order line.
- **Cancelling a purchase order** after a partial receipt cancels only the remaining
  quantity. Received stock stays.
- **Negative stock is reported, not hidden.** If movements after a count push on-hand
  below zero, the API returns the negative value with readiness
  `stock: inconsistent — record a count`. It is never clamped to zero.

### 2.4 Concurrency and idempotency

- Every stock-changing request takes the existing per-seller advisory lock
  (`pg_advisory_xact_lock(7401, seller)`), as imports and rollbacks already do.
- Every write path has an identity:
  - snapshot batches: `(seller, idempotency_key)`, with the content hash stored;
  - events: `(seller, source_id, external_event_id)`;
  - receipts: `(seller, idempotency_key)`;
  - purchase-order creation: `(seller, idempotency_key)`.
- Same key and same content returns the original result (`replayed: true`). Same key and
  different content returns `409`. This is the same semantics as import identity.

### 2.5 Time

- `observed_at`, `effective_at` and `received_at` are instants (`timestamptz`).
- The business date is derived using the source's timezone (Asia/Karachi by default),
  as for sales.
- `recorded_at` is the server time and is never used as the measurement time.

---

## 3. Migration plan

Two migrations, each with a `.down.sql`, rehearsed with `scripts/rehearse-migration.js`.
The upgrade tests cover legacy rows, duplicates and ownerless products.

### 3.1 `004_inventory_ledger.sql` (Stage 1a)

Enum-like values are `VARCHAR` with `CHECK`s, as in 002 and 003. Every table carries
`seller_id`, with composite foreign keys to `(id, seller_id)` or `(id, user_id)`.

```sql
inventory_locations (id, seller_id, name, timezone, is_default, created_at,
  UNIQUE (id, seller_id), one default per seller via a partial unique index)

stock_snapshot_batches (            -- identity of one submission (form, file or connector)
  id, seller_id, idempotency_key, content_sha256,
  source_kind  CHECK IN ('manual_count','count_file','connector','legacy_migration'),
  source_id    -> data_sources (id, seller_id) NULL,
  upload_id    -> data_uploads (id, uploaded_by) NULL,   -- count files are import versions
  observed_at, recorded_at, status CHECK IN ('active','revoked'), result_summary JSONB,
  UNIQUE (seller_id, idempotency_key))

stock_snapshots (
  id, seller_id, batch_id -> (id, seller_id), product_id -> products (id, user_id),
  location_id -> (id, seller_id),
  quantity INT NOT NULL CHECK (quantity >= 0),
  observed_at TIMESTAMPTZ NULL,           -- NULL only for unverified legacy rows
  verification CHECK IN ('verified','unverified'),
  status CHECK IN ('active','revoked'),
  CHECK (observed_at IS NOT NULL OR verification = 'unverified'))

stock_movements (
  id, seller_id, product_id, location_id,
  kind CHECK IN ('receipt','receipt_reversal','shipment','customer_return',
                 'damage','found','correction'),
  quantity INT NOT NULL CHECK (quantity <> 0),
  CHECK (sign matches kind: receipt / customer_return / found > 0;
         shipment / damage / receipt_reversal < 0; correction either),
  effective_at TIMESTAMPTZ NOT NULL, recorded_at,
  source_id NULL, external_event_id NULL,   -- connector events
  idempotency_key NULL,                     -- manual / receipt writes
  receipt_line_id NULL (FK added in 005), reversal_of -> stock_movements NULL,
  reason TEXT, created_by,
  status CHECK IN ('active','revoked'),
  UNIQUE (seller_id, source_id, external_event_id),
  UNIQUE (seller_id, idempotency_key))

inventory_policies (                -- manual settings; no AI here
  seller_id, product_id NULL (NULL = seller default), location_id,
  reorder_threshold INT NULL, stock_stale_after_days INT NOT NULL DEFAULT 7,
  provenance CHECK IN ('seller','legacy_file'), updated_by, updated_at,
  UNIQUE (seller_id, product_id, location_id))
```

**Backfill**, inside the migration:

1. One default location per seller that owns products.
2. Each owned product's legacy `inventory` row becomes a `legacy_migration` snapshot:
   `unverified`, `observed_at NULL`, with the legacy `updated_at` kept as a recorded note.
   Where a product has duplicate rows, take the newest `(updated_at, id)` and report the
   discarded duplicates in the migration log table.
3. Legacy `reorder_threshold` becomes a product policy with `provenance = 'legacy_file'`.
4. Rows on products with no owner are not migrated. They are counted and reported.

**The legacy `inventory` table:** it is kept, read-only, and no longer written after 004.
The down migration restores reads from it. Dropping it is a later migration, after
Stage 2.

### 3.2 `005_suppliers_purchasing.sql` (Stage 1b)

```sql
suppliers (id, seller_id, name, email, phone, default_currency CHAR(3), notes, active,
  UNIQUE (id, seller_id), UNIQUE (seller_id, lower(name)))

product_suppliers (id, seller_id, product_id, supplier_id,
  supplier_sku, unit_cost NUMERIC(12,2) NULL CHECK (>= 0), currency CHAR(3) NULL,
  lead_time_days INT NULL CHECK (0..365),        -- seller-entered, provenance 'seller'
  min_order_qty INT NOT NULL DEFAULT 1 CHECK (>= 1),
  pack_size INT NOT NULL DEFAULT 1 CHECK (>= 1),
  is_preferred BOOL, active BOOL, updated_by, updated_at,
  CHECK (unit_cost IS NULL OR currency IS NOT NULL),
  UNIQUE (seller_id, product_id, supplier_id),
  one active preferred supplier per product via a partial unique index)

purchase_orders (id, seller_id, supplier_id, location_id, currency CHAR(3) NOT NULL,
  status CHECK IN ('draft','approved','ordered','partially_received','received','cancelled'),
  idempotency_key, version INT,             -- optimistic locking for edits and transitions
  expected_arrival DATE NULL,               -- supplier promise, business date
  created_by, created_at, approved_by, approved_at, ordered_at,
  first_receipt_at, completed_at, cancelled_at, cancel_reason, notes,
  UNIQUE (seller_id, idempotency_key))

purchase_order_lines (id, seller_id, po_id, product_id,
  quantity_ordered INT CHECK (> 0), quantity_cancelled INT DEFAULT 0,
  unit_cost NUMERIC(12,2) NULL,             -- copied from product_suppliers when drafted
  pack_size INT, min_order_qty INT,         -- terms as at drafting
  UNIQUE (po_id, product_id))

purchase_receipts (id, seller_id, po_id, received_at TIMESTAMPTZ, recorded_at,
  idempotency_key, note, UNIQUE (seller_id, idempotency_key))

purchase_receipt_lines (id, seller_id, receipt_id, po_line_id, quantity INT CHECK (> 0))
-- each receipt line writes exactly one 'receipt' movement (FK stock_movements.receipt_line_id)
```

**Status transitions** (all others are refused with `409`):

- `draft → approved | cancelled`
- `approved → ordered | cancelled`
- `ordered → partially_received | received | cancelled`
- `partially_received → received | cancelled` (cancel closes the remainder)

**Editing:**
- Lines, supplier and currency can be edited only in `draft`.
- `expected_arrival` can also change in `approved` or `ordered`; the history keeps the
  previous value.

**Approval checks:**
- the order has at least one line;
- every line belongs to this seller and this supplier link;
- one currency;
- the quantity is a multiple of the pack size and at least the minimum order (decision D5);
- costs are present or explicitly marked unknown.

**Receiving:**
- allowed only from `ordered` or `partially_received`;
- quantity ≤ remaining on the line (decision D4);
- the status is updated in the same transaction as the movements.

**Inbound** (reported, not added to on-hand) = for orders in `ordered` or
`partially_received`, Σ (ordered − cancelled − received). Approved but not yet ordered is
reported separately as "approved, not sent".

**Lead-time evidence:** `ordered_at`, `expected_arrival`, `first_receipt_at` and
`completed_at` are recorded for Stage 5. Nothing is learned from them in Stage 1.

---

## 4. API contracts

All routes are authenticated. The seller always comes from the token. Another seller's
id returns `404`, never `403`, so existence is not revealed. Every list is paginated.
Counts are computed over all of the seller's products.

### 4.1 Stock (Stage 1a)

**`GET /api/inventory/items?page=&page_size=&state=&q=`**

```json
{
  "items": [{
    "product_id": 0, "name": "", "category": "",
    "stock": {
      "on_hand": 0, "known": true, "observed_at": "", "verification": "verified",
      "basis": "count", "movements_since_count": 0, "before_count_events": 0
    },
    "inbound": { "ordered_remaining": 0, "next_expected": "" },
    "policy": { "reorder_threshold": 0, "stale_after_days": 7 },
    "readiness": { "...": "see §5" },
    "threshold_alert": "below | at | above | not_set | unknown_stock"
  }],
  "page": 1, "page_size": 50, "total": 0,
  "counts": { "unknown_stock": 0, "stale": 0, "below_threshold": 0 }
}
```

**`GET /api/inventory/items/:productId`** returns the same item plus the snapshot history,
recent movements, supplier links and open purchase orders.

**`POST /api/inventory/snapshots`** — form or connector.

```json
{
  "idempotency_key": "", "observed_at": "", "source_id": null,
  "items": [{ "product_id": 0, "quantity": 0 }]
}
```

- Connectors may send `product_name` instead of `product_id`. It is resolved within the
  seller only.
- Only explicit items are recorded. Products not listed are unchanged; there is no
  implicit zero.
- `observed_at` must not be later than now.

**`POST /api/inventory/count-files`** — multipart, a stock-count CSV
(`product_name, quantity`) plus a seller-entered `counted_at`.

- Creates a `data_uploads` row (`source = 'stock_count'`, import identity, a version
  number), so it is rolled back like any other import.
- Rejected rows are reported. Partial files are allowed, because a count does not claim
  completeness the way coverage does.

**`POST /api/inventory/movements`** — manual adjustments
`{ idempotency_key, product_id, kind, quantity, effective_at, reason }` and connector
events `{ source_id, external_event_id, ... }`.

- `receipt` and `receipt_reversal` are refused here; they come only from purchase orders.

**`GET` / `PATCH /api/inventory/items/:productId/policy`** and
**`GET` / `PATCH /api/inventory/policy`** (seller default)

**`GET /api/inventory/alerts`** — kept for the overview, rebuilt on the new ledger:

- returns **all** below-threshold products, with `product_id` and `category`;
- products with unknown stock are returned as `risk_level: 'unknown'`, not omitted;
- the old fields are unchanged.

### 4.2 Suppliers and purchasing (Stage 1b)

- `GET /POST /PATCH /api/suppliers`
- `GET /PUT /DELETE /api/products/:id/suppliers/:supplierId`, where DELETE deactivates the link
- `POST /api/purchase-orders`
  `{ idempotency_key, supplier_id, currency, expected_arrival?, lines: [{ product_id, quantity }] }`
  creates a draft, with terms copied from the product–supplier links.
- `PATCH /api/purchase-orders/:id` (`If-Match: version`; draft only, except `expected_arrival`)
- `POST /api/purchase-orders/:id/approve | /mark-ordered | /cancel { reason }`
- `POST /api/purchase-orders/:id/receipts`
  `{ idempotency_key, received_at, lines: [{ line_id, quantity }] }`
- `POST /api/purchase-orders/:id/receipts/:receiptId/reverse { idempotency_key, reason }`
- `GET /api/purchase-orders?status=` and `GET /api/purchase-orders/:id`, which includes
  receipts and the status history

Transitions return `{ purchase_order, stock_effects: [{ product_id, movement_id, quantity }] }`
so the UI can show exactly what changed.

---

## 5. Readiness contract (Stage 1a)

Each item carries machine-readable dimensions. Each dimension has
`{ state, reason, action }` and English text, computed in `lib/inventoryReadiness.js`.

| Dimension | States |
|---|---|
| stock | `missing`, `unverified`, `stale` (older than `stale_after_days`), `inconsistent` (computed < 0), `current` |
| sales_history | Reuses the forecasting rules (confirmed days only): `no_sales`, `needs_confirmation`, `insufficient` (< 28), `average_only` (28–179), `sufficient` (≥ 180), and `stale_history` when confirmed history ends more than `stale_after_days` before today in the business date |
| supplier | `none`, `missing_lead_time`, `missing_cost`, `complete` (pack size and minimum order have defaults, so they never block) |
| inbound | `none`, `open`, `overdue` (past `expected_arrival` and not received), `no_expected_date` |
| commitments | `not_tracked` (Stage 1, always) |
| policy | `threshold_set`, `threshold_not_set` |

`overall` is one of:

- `blocked` — stock `missing` or `inconsistent`;
- `provisional` — stock `unverified` or `stale`, or commitments `not_tracked`;
- `ready_for_planning` — reserved for Stage 2 once forecast alignment exists.

**Readiness never invents a value.** Unknown stock yields `threshold_alert: unknown_stock`,
never "healthy".

---

## 6. UI changes

All changes use the existing tokens and components. No colour changes.

### Inventory page (rewritten)

- **Remove `MOCK_PRODUCTS`.** The page has three states:
  - **loading:** a skeleton;
  - **error:** an error panel with Retry; no sample data;
  - **empty:** "No products yet", with links to Data Integration and "Record stock".
- **Overview figures** come from `counts` across all products: unknown stock, stale,
  below threshold, open inbound and overdue.
- **Item table (paginated):**
  - on-hand, shown as "—, no count" when unknown;
  - observed date and a verified/unverified badge;
  - movements since the count;
  - threshold and inbound;
  - readiness chips with the next action.
- **Product drawer:**
  - snapshot and movement history;
  - supplier links;
  - open purchase orders;
  - forms to record a stock count, record an adjustment (reason required) and set the
    reorder threshold.
- **Bulk "Stock count"** dialog: CSV upload plus counted-at date and time, with the
  rejected-rows report and the import version.

### Suppliers (tab inside Inventory)

- A supplier list with create and edit.
- A product link form: cost, currency, lead days, minimum order, pack size, preferred.
- Missing settings are shown explicitly, for example "Lead time not set".

### Purchase orders (tab inside Inventory)

- Create a draft by choosing a supplier and products. Quantities are validated against
  pack size and minimum order as the seller types.
- Then approve, mark as ordered, and receive (partial receipts allowed, `received_at`
  required) or cancel.
- A per-order timeline, with the stock effects of each receipt.

### Elsewhere

- **Overview:** reads the rebuilt alerts and shows "unknown stock" separately. No sample
  data.
- **Data Integration:** if a sales file contains stock columns, the result says
  "Stock columns were not applied to stock — record a stock count instead" (decision D1).
- **Pricing page:** not touched. It is listed for a later cleanup.

---

## 7. Tests (backend `node --test`, run in three timezones as now)

1. **Ledger arithmetic:**
   - snapshot plus later movements;
   - a movement exactly at `observed_at` is excluded;
   - a late event before the count is excluded and flagged;
   - no snapshot gives unknown, even with receipts;
   - zero is a known 0, distinct from missing;
   - a negative result gives `inconsistent`.
2. **No double counting:**
   - two connector sources at one location are not summed (latest wins);
   - a receipt before a later count is not added twice;
   - fulfillment event replay is a no-op;
   - the same event id with different content returns `409`;
   - concurrent identical receipts produce one movement.
3. **Sales never touch stock:** a sales upload containing `stock_level` leaves the
   snapshots unchanged; store connect too; rollback of a sales upload leaves stock
   unchanged.
4. **Rollback:**
   - rolling back a count file revokes its snapshots and the previous count becomes
     current, marked stale;
   - a receipt reversal reopens the line quantity;
   - cancelling after a partial receipt keeps the received stock.
5. **Purchase-order lifecycle:**
   - every allowed transition and every refused one;
   - edit only in draft;
   - version conflict returns `409`;
   - over-receipt is refused;
   - single currency;
   - pack and minimum-order violations at approval;
   - inbound and overdue are computed correctly.
6. **Seller isolation** (table-driven over every new route): another seller's product,
   supplier, purchase order, receipt or snapshot returns `404`; composite foreign keys
   refuse cross-seller rows written directly.
7. **Readiness matrix:** every state of every dimension, using fixtures built with the
   coverage helpers.
8. **Migration upgrade test** (disposable database):
   - legacy `inventory` rows become unverified snapshots plus policies;
   - duplicate rows are resolved and reported;
   - ownerless rows are skipped and counted;
   - `down` then `up` works;
   - the counts check passes in `rehearse-migration.js`.
9. **Updated existing tests:**
   - the stock assertions in `access.test.js` and `rollback.test.js` move to the ledger;
   - the `salesCsv(..., withStock)` helper keeps its stock columns, to prove they are no
     longer applied.
10. **UI evidence** (harness):
    - empty, error and data states;
    - each form, including validation errors;
    - a purchase order from draft through a partial receipt to received;
    - mobile width.

---

## 8. Architectural concerns

1. **Without a fulfillment feed, current stock decays.**
   - Most sellers here upload historical sales files, not live events. After a count,
     on-hand does not move until the next count or receipt.
   - Readiness labels it stale after N days, but the Stage 2 outlook would be planning
     from "stock as of the count".
   - Option, for Stage 2 (decision D3): an **estimated position** = latest count −
     confirmed sales after the count + receipts. It would be computed only where sales
     coverage is confirmed for the whole gap, labelled as an estimate, and never stored
     as movements.
2. **Matching sales dates to stock times.** Sales are business dates; counts are
   instants. A count taken during a business day splits that day's sales. Stage 2 needs a
   documented rule, for example "sales on the count's business date are assumed included
   if the count is after closing time". Stage 1 only stores the instants.
3. **Connector identity.** Mapping a connector snapshot to a physical location needs a
   source→location setting. With one location it is the default. Summing across channels
   is prevented by the "latest observation wins" rule, not by trusting connectors.
4. **The legacy `inventory` table stays during transition.** The overview, the alerts
   endpoint and `/products` switch to the ledger in 1a. The `ownership_repair_dryrun.sql`
   read of `inventory` is updated to read the ledger.
5. **Purchase-order costs are snapshots.** Supplier cost changes after drafting do not
   change existing orders. Recommendations in later stages must re-read current terms.
6. **Size.** 1a and 1b each touch the migration, backend, UI and tests. Two review
   checkpoints are safer than one large change.

---

## 9. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Stock columns (`stock_level`, `reorder_threshold`) inside **sales** files | Stop writing them to stock and say so in the upload result. Stock comes from counts (form or count file with a seller-entered time), connector snapshots and receipts. |
| D2 | Legacy stock values | Migrate them as **unverified** opening observations (no measurement time) and ask for a count. Migrate thresholds as policies with `legacy_file` provenance. |
| D3 | Estimated stock between counts from confirmed sales | Stage 2, as a labelled estimate only, where coverage is confirmed. Not in Stage 1. |
| D4 | Receiving more than ordered | Refuse; the seller amends the draft or raises a new order. |
| D5 | Pack-size and minimum-order violations | Refuse at approval, with a clear message. No silent rounding. |
| D6 | Default stale tolerance for stock | 7 days, editable per seller and per product. |
| D7 | Commitments (reservations and backorders) | Defer. Readiness shows `not_tracked`, so plans are provisional. |
| D8 | Shipment / fulfillment event API | Build it with idempotency and tests in 1a, unused until a connector sends events. |
| D9 | Currency | ISO code required whenever a cost is entered, and one currency per order. Seller default currency PKR. |
| D10 | Demo data | No in-app sample fallback. Provide an explicit demo seeding script, plus an empty state that links to it in development only. |
| D11 | Split | Stage 1a (ledger, readiness, UI states, legacy migration) and Stage 1b (suppliers, purchase orders, receipts). Each is reviewed and merged separately. |

---

## 10. Recorded decisions for Stage 1b (architect review of Stage 1a)

Recorded now, implemented in 1b. Nothing below exists in the 1a code.

**Receipt reversal has two different meanings, with different accounting.**

| | (a) Correction: the receipt was recorded wrongly | (b) Return: goods physically go back now |
|---|---|---|
| What happened physically | Nothing; the record was wrong | Units leave the location at the return time |
| Ledger effect | The receipt movement is **revoked** (kept as evidence, excluded from arithmetic) | A new negative movement `supplier_return` at the return time |
| Counts after the receipt | A later count stays authoritative: revoking a receipt that falls *before* the selected count does not change on-hand | Applied like any movement after the selected count |
| Purchase order | Received quantity decreases by the corrected amount | Received quantity is unchanged; returned quantity is recorded separately |

- Never both: a correction does not also subtract the units again, and a return never
  revokes the original receipt.
- Cumulative corrections plus returns for a receipt line may not exceed the quantity
  received on that line (refused, nothing written).
- After a correction, `remaining = ordered − cancelled − received`; the status is
  recomputed (`received` → `partially_received` or `ordered`).
- A **cancelled** order never reopens and never becomes inbound again. A correction
  against a cancelled order adjusts its received quantity only; its remaining stays 0.
  A return does not change inbound.
- Every revision of the promised arrival date and every state transition is kept as
  durable history (who, when, from → to, reason), never overwritten in place.
