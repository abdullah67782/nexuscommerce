# Inventory AI — Stage 2 design proposal: explainable replenishment engine

Status: **approved with amendments 1–4 and decisions Q1–Q10 (architect review), and implemented.** Implementation and evidence: `docs/inventory-stage2-report.md`. §11 lists the amendments and where each is applied; the sections below already include them.

Stage 2 builds on:
- the Stage 1a stock ledger;
- the Stage 1b purchasing records;
- the frozen forecasting release `nexus-v2-shared-20261008`, with its routing rule unchanged.

No model is trained or changed in this stage.

## 1. Goal and boundaries

For each product, the engine answers five questions, and every answer comes with its inputs, assumptions and missing information:

1. What demand is estimated over the next 7 and the next 28 days?
2. How much stock is estimated to remain over those periods?
3. Is a shortage expected before a new order could arrive?
4. How much should be ordered now? Show the raw need, the minimum-order adjustment and the pack adjustment separately.
5. Why? Give a plain-language account of the calculation, the assumptions and what is missing.

Hard boundaries:
- The engine is a **pure calculation**. It reads inputs and returns a result. It never writes stock, never creates, approves or sends a purchase order, and never changes a policy.
- The only path from a recommendation to an order is a seller-initiated **draft** (§6.4), which still needs the normal approval and ordering steps.
- No statistical guarantees:
  - safety stock is a seller setting or a labelled scenario;
  - there are no service-level probabilities;
  - there are no precise stockout dates.
- Forecast totals are never re-dated. A forecast that starts in the past covers fewer of the coming days, and the result says so.

## 2. Inputs and their contracts

| Input | Source (existing) | Used as |
|---|---|---|
| Planning date `D` | Today in the location timezone (Asia/Karachi by default) | Day 1 of every projection. Day 1 is treated as a full day of demand still to come; this is conservative because part of today has passed (assumption A4). |
| Physical stock `S0` | `stockLedger.positions` (Stage 1a) | Last verified count plus recorded movements: `on_hand`, `last_count.observed_at`, count age, `movement_tracking`, `position_type`, `legacy` |
| Recorded sales not reflected in stock `U` | Same query as `untracked_sales_since_count`, extended to return **units** | Sales from sources without a shipment feed, on business dates **after** the count date. Count-date sales are ambiguous (before or after the count?) and are reported separately, never subtracted. |
| Forecast | Existing v2 path (`productHistory`, then ML `POST /v2/forecast`) via a shared backend forecast service (§6.1) | `origin F` (first forecast date), totals `T7` (dates F..F+6) and `T28` (F..F+27), method (shared model / TSB / 28-day average), tier, pattern group, `models_release` |
| Incoming | `purchase_order_line_quantities` (Stage 1b) | Remaining quantity on `ordered` / `partially_received` orders, split into **dated, not yet due** (expected arrival ≥ D), **overdue** (expected arrival < D) and **undated** |
| Not yet placed | Orders in `approved` or `draft` status | Never counted as incoming. Reported as a double-ordering warning. |
| Supplier terms | `product_suppliers`: the preferred active link, or the only active link | Lead time `L` (days), pack size, minimum order (MOQ), unit cost and currency |
| Policy | `inventory_policies` (product row, then seller default) | Stale tolerance (existing); new: review period `R` and safety stock `SS` (§5) |

## 3. Calculation rules

### 3.1 Date alignment (no silent re-dating) — amendment 2

`g = D − F` is the forecast lag in days (`F` = first forecast date = the day after confirmed history ends). Planning day `k` is date `D + k − 1`; it is forecast day `j = k + g`. Forecast day `j` is **always** date `F + j − 1`: a forecast is never shifted to start today.

| Lag | Meaning | Result |
|---|---|---|
| `g = 0` | Confirmed history ends yesterday | Aligned. Planning days 1–28 are covered. Eligible for `provisional`. |
| `1 ≤ g ≤ 7` | History ends `g` days before yesterday | Planning days 1..(28 − g) are covered. The 7-day outlook still covers all 7 upcoming days (planning days 1–7 = forecast days g+1..g+7). The 28-day outlook is labelled "(28 − g) days covered (of 28)", e.g. "25 days covered" for g = 3. The result is **`indicative`** (Q6): no draft button. |
| `g > 7` | Beyond the documented 7-day forecast-age limit (separate from the stock tolerance, Q6) | `needs_information: forecast_too_old` |
| `g = −1` | Sales are confirmed through today, so the forecast starts tomorrow | Said explicitly. The today-based outlook and quantity are **withheld** (`indicative`, `outlook_withheld` / `suggestion_withheld`). The planning date is not moved, and today is not assumed finished. The forecast totals are shown with their own dates (F..F+6, F..F+27). |

Every outlook returns its actual `start`, `end`, `covered_days`, `complete` and `label`.

### 3.2 Demand over time (labelled assumption A1)

v2 returns two independent totals and no daily curve. To place demand against arrival dates, the engine uses **even spreading inside each forecast block**. This is shown as assumption A1 wherever it affects a number.

- Forecast days 1–7: `T7 / 7` per day.
- Forecast days 8–28: `(T28 − T7) / 21` per day, used only when `T28 ≥ T7`.
- If `T28 < T7` (cross-horizon inconsistency, amendment 3):
  - flag `forecast_horizons_inconsistent` with a warning quoting both daily rates;
  - show **two independent estimates**: the 7-day outlook from `T7 / 7` per day (covering the planning days inside forecast days 1–7, i.e. 7 − g of them) and the 28-day outlook from `T28 / 28` per day;
  - do not derive weeks 2–4 from the difference;
  - return **no order quantity** and no shortage-before-arrival figure (`suggestion_withheld: forecast_horizons_inconsistent`); status `indicative`.

The daily grid is internal. Responses report **horizon totals and checkpoints**:
- end of day 7;
- end of the covered period;
- shortage before arrival.

There are no daily curves and no calendar stockout dates. "Approximate cover" is reported as a whole number of days under A1, and is **omitted** for the rare-sales pattern (TSB), where an even rate of a fraction of a unit per day says nothing about when the next sale happens.

### 3.3 Stock projection without a new order

Conventions:
- **A2:** a dated delivery becomes usable the day **after** its expected date. This is conservative.
- **A3:** unmet demand is **lost**, not back-ordered. Stock never goes below 0, and shortage is counted in units.

For planning day `k`:

```
available_k = stock_{k−1} + usable arrivals on day k   (dated, not-overdue incoming only)
sold_k      = min(available_k, demand_k)
short_k     = demand_k − sold_k
stock_k     = available_k − sold_k                     stock_0 = S0 (last-known physical)
```

The projection uses **only dated, not-yet-due incoming**. Overdue and undated quantities are never assumed to arrive on time. They are reported separately and used only in the labelled alternative quantity (§3.5).

### 3.4 Shortage before replenishment arrives

An order placed today is expected on `D + L`, so under A2 it is usable from day `L + 2`.

```
shortage_before_arrival = Σ short_k   for k = 1 .. L+1
```

- This shortage cannot be prevented by an order placed now. The explanation says so and suggests checking with the supplier.
- It is computed only when `L` is known and `L + 1 ≤ covered_days`.

### 3.5 Suggested order quantity — amendment 1 (delivery timing)

An order placed today is usable from day `a = L + 2` (A2). The review window is days `a .. a + R − 1`. With the daily simulation of §3.3 (lost sales before `a`), let `s = stock_{a−1}` and, for each day `k` in the window,

```
B_k = s + Σ_{i=a..k} (scheduled arrivals_i − demand_i)        (no new order)
```

Once nothing inside the window is short, the balance with an extra `Q` on day `a` is `B_k + Q`, so the **smallest** quantity that leaves no shortage on **every** day of the window and at least `SS` at its end is

```
raw_need  = max(0,  −min_k B_k,  SS − B_{a+R−1})
raw_units = ceil(raw_need)                    (whole units)
```

Every daily checkpoint is checked, not only the final balance: a scheduled delivery that arrives midway or on the last day of the window cannot hide a gap before it. The binding constraint is reported (`shortage_inside_window` with the delivery it precedes, or `safety_stock_at_window_end`). Shortages before day `a` stay separate (§3.4) and are never added to the quantity.

Supplier constraints are then applied as separate, visible steps, only when `raw_units > 0`:

```
after_minimum = max(raw_units, MOQ)                → "+x to reach the minimum order"
final         = ceil(after_minimum / pack) × pack  → "+y to complete packs of N"
cost          = final × unit_cost  (in the link's currency; omitted when cost is unknown)
```

- `raw_units = 0` gives "no order needed now". The minimum order never forces an order.
- **Projected outcome after the order** (`after_order`): the simulation re-run with `final` on day `a` — shortage in the window (0), lowest stock in the window, stock at the window's end, whether `SS` is met, the 7/28-day outlook with the order, the unchanged shortage before it is usable, and any shortage after the window within the forecast.
- **Alternative quantity:** if overdue or undated incoming exists, the same steps with that quantity usable tomorrow, labelled "If the overdue and undated deliveries (N) are usable tomorrow". The main suggestion never assumes they arrive.
- **Coverage limit:** if `a + R − 1 > covered_days`, the result is `needs_information: horizon_beyond_forecast`. No extrapolation.
- **Unplaced orders:** a draft or approved-not-ordered order for the product is never incoming. The suggestion is unchanged (R12) with a double-ordering warning, and no further draft is offered while it exists (`draft_blocked: unplaced_order_exists`; implementation judgement call, see the report).

### 3.6 Stock limitations and the sales-adjusted scenario

- **Reconciliation (review round 2):** if the Stage 1a reconciliation state is `needs_review` (movements at exactly the count's instant from another source, so it is unknown whether the count includes them), the result is `indicative` with reason `stock_needs_reconciliation` and the events listed; no draft. The state and each ambiguous event are part of the fingerprint, so a newly recorded ambiguity invalidates older recommendations.
- Stage 2 never treats stock as verified-current: the Stage 1a review fixed `movement_tracking` at best `declared_unverified`. Every result carries the limitation `stock_last_known`, with the count date and age.
- Sales recorded after the count date are attributed per source (Q7). A declared feed does not prove deduction:
  - sales on days no declared feed covers are **not deducted**;
  - sales on days a feed covers are matched against shipment movements recorded from that same source after the count; the unmatched remainder is also counted as not deducted and disclosed as unresolved ("covered without shipment");
  - shipments beyond covered sales are disclosed and not used;
  - sales on the count's business date are ambiguous (before or after the count?) and are reported, never subtracted.
- If `U > 0`, the response adds the **sales-adjusted scenario**: the same calculation started from `max(0, S0 − U)`, labelled "If the U unit(s) sold since the count have already left stock". Measured stock is never altered; the base result uses measured stock.
- When more than one source contributes, possible overlap (the same orders reaching two sources) is disclosed.

### 3.7 Result states

| `status` | When | Order quantity |
|---|---|---|
| `needs_information` | A required input is missing (codes below) | None. Each code carries a message and an action. Outputs that do not depend on the missing input are still returned (for example, demand and shortage by horizon when only the lead time is missing). |
| `indicative` | The count is older than its stale tolerance; stock needs reconciliation; the forecast lag is 1–7 days; the forecast starts tomorrow (outlook and quantity withheld); or the forecast horizons are inconsistent (no quantity). | Shown as "indicative only — not actionable". No draft button. |
| `provisional` | All required inputs are present; stock is last-known | Actionable suggestion, shown with all limitations |
| `unavailable` | Forecast service down | No forecast numbers. Never falls back to legacy forecasts or cached numbers presented as current. |

`current` is **reserved**. It needs verified synchronisation coverage, which Stage 2 does not have.

`needs_information` codes, each with an action:

| Code | Action |
|---|---|
| `stock_missing`, `stock_unverified_only`, `stock_inconsistent` | Record a count |
| `forecast_no_sales`, `forecast_needs_confirmation`, `forecast_insufficient_history` (< 28 confirmed days) | Confirm periods or add history |
| `forecast_too_old` (lag > 7 days) | Confirm recent sales |
| `supplier_missing` | Link a supplier |
| `supplier_choice_needed` | Several active suppliers and none preferred: choose one |
| `lead_time_missing` | Set the lead time |
| `horizon_beyond_forecast` | Shorten the review period, or plan manually |
| `timezone_mismatch` (review round 2) | Use the same timezone for the sales source and the stock location. Sale dates are business days in the source's timezone and the planning grid uses the location's, so different zones mean the daily totals and stock days are different intervals. The combined projection, the quantity and the draft are withheld; stock facts, incoming orders and the forecast totals (with their own dates, in the sales timezone) are kept separately. No conversion is attempted. |

Zero demand (`T7 = T28 = 0`, for example a dormant product):
- no cover figure;
- the note "No sales are expected in the forecast period. This does not mean stock lasts forever";
- an order only if `SS` exceeds the projected stock.

## 4. API (proposed)

All routes are authenticated and seller-scoped (another seller's ids give 404). None of them write stock or orders.

| Route | Purpose |
|---|---|
| `GET /api/inventory/replenishment?page&state&q` | Action queue. Paginated items, with counts across **all** products: `needs_information`, `shortage_within_7`, `shortage_before_arrival`, `order_suggested`, `indicative`. |
| `GET /api/inventory/items/:id/replenishment` | Full result for one product (below) |
| `POST /api/inventory/items/:id/replenishment/scenario` | `{ review_days?, safety_stock_units?, lead_time_days?, include_uncertain_incoming? }` returns the same shape labelled `scenario`. It is **not** saved, and it does not change the policy. |
| `PATCH /api/inventory/items/:id/policy` and `/policy` | Extended with `review_period_days` and `safety_stock_units` |
| `POST /api/purchase-orders/from-recommendation` | `{ recommendation_id, inputs_sha256 }` creates a **draft** only (§6.4). 409 `recommendation_stale` with the recomputed result if any input changed; 409 `not_actionable` unless provisional with a quantity; a retry returns the existing draft (200, `replayed`). |

Example response for acceptance case R1 (§7), abbreviated (the implemented shape also has `outlook.7/28.start/end/covered_days/label`, `suggestion.window`, `suggestion.binding`, `suggestion.after_order`, `draft_blocked` and `explanation`):

```json
{
  "product_id": 1, "status": "provisional", "engine_version": "replenishment-1",
  "recommendation_id": 412, "inputs_sha256": "…", "planning_date": "2026-10-09", "timezone": "Asia/Karachi",
  "stock": { "on_hand": 55, "basis": "last_known", "counted_at": "2026-10-08T15:00:00Z", "count_age_days": 0,
             "movement_tracking": "declared_unverified", "sales_since_count_not_deducted": { "units": 0, "count_day_ambiguous_units": 0 } },
  "forecast": { "origin": "2026-10-09", "lag_days": 0, "models_release": "nexus-v2-shared-20261008",
                "method": "shared_model", "pattern": "regular", "totals": { "7": 28, "28": 120 }, "horizons_consistent": true },
  "incoming": { "scheduled": [{ "po_id": 7, "quantity": 30, "expected": "2026-10-14", "usable_from": "2026-10-15" }],
                "overdue": [], "undated": [], "approved_not_sent": 0, "drafts": 0 },
  "supplier": { "id": 3, "name": "Faisalabad Textile Mills", "lead_time_days": 10, "pack_size": 10, "min_order_qty": 20,
                "unit_cost": 2800, "currency": "PKR", "source": "preferred" },
  "policy": { "review_period_days": 14, "safety_stock_units": 10, "safety_stock_basis": "seller_setting" },
  "outlook": {
    "7":  { "covered_days": 7,  "demand": 28.0,  "stock_at_end": 57.0, "shortage_units": 0 },
    "28": { "covered_days": 28, "demand": 120.0, "stock_at_end": 0,    "shortage_units": 35.0 },
    "approximate_cover_days": 20, "runs_short_within": "days_8_to_28"
  },
  "before_arrival": { "order_usable_from": "2026-10-20", "shortage_units": 0 },
  "suggestion": { "actionable": true, "raw_need": 31.86, "raw_units": 32,
                  "minimum_adjustment": 0, "after_minimum": 32, "pack_adjustment": 8, "quantity": 40,
                  "cost": { "amount": 112000, "currency": "PKR" }, "alternative_if_uncertain_incoming_arrives": null },
  "assumptions": [
    { "code": "A1", "text": "The 7- and 28-day totals are spread evenly within each block (days 1–7 and 8–28). v2 does not give daily demand." },
    { "code": "A2", "text": "Deliveries are usable the day after their expected date." },
    { "code": "A3", "text": "Demand that cannot be met is lost, not back-ordered." },
    { "code": "A4", "text": "Today counts as a full day of demand still to come." }
  ],
  "limitations": [ { "code": "stock_last_known", "text": "Stock is last counted on 8 Oct; a shipment feed is declared but its completeness is not verified." },
                   { "code": "safety_stock_seller_set", "text": "Safety stock of 10 is your setting; it is not a calculated protection level." } ],
  "missing": [],
  "explanation": [ "…plain-language steps generated from the numbers above (§6.3)…" ]
}
```

## 5. Schema changes (migration 006, proposed)

1. `inventory_policies` gains:
   - `review_period_days INT NULL CHECK (1..28)`;
   - `safety_stock_units INT NULL CHECK (>= 0)`;
   - the existing provenance pattern (`seller`).
   - The seller default for the review period is 7 days, labelled "default" until the seller sets one (§10 Q1). Safety stock defaults to **none (0)**, with the limitation "No safety stock: the suggestion covers expected demand only".
2. `replenishment_recommendations`, an append-only record (shadow log) with:
   - `id`, `seller_id`, `product_id`, `location_id`, `planning_date`, `computed_at`;
   - `engine_version`, `models_release`, `forecast_origin`;
   - `inputs` JSONB (the exact numeric inputs), `inputs_sha256`, `output` JSONB, `status`;
   - a unique key on `(seller_id, product_id, planning_date, engine_version, inputs_sha256)` (Q10), so recomputing with identical inputs and engine adds nothing;
   - append-only (update and delete refused); `actionable` only when provisional with a quantity above zero and a supplier;
   - scenarios and `unavailable` results are not logged.

   It serves three purposes:
   - auditability ("what did the system say on 9 Oct and why");
   - stale detection for draft creation;
   - later shadow-mode evaluation against realised outcomes. That evaluation is **not** performed in Stage 2.
3. `purchase_orders.source_recommendation_id` (nullable, composite foreign key) for drafts created from a recommendation, with a partial unique index: at most one order per recommendation.

There are no changes to the stock ledger or to the purchasing rules. `006 down` refuses once recommendations or linked drafts exist, following the 004/005 pattern.

## 6. Architecture

### 6.1 Modules

| Module | Responsibility |
|---|---|
| `lib/forecastService.js` | The v2 path refactored out of `routes/forecast.js`: `productHistory`, then the ML call, then the existing notes. Used by the forecast route **and** the replenishment loader, so neither calls the other through a user-facing route. Behaviour and model calls are unchanged. For replenishment only, a per-process cache keyed by the history fingerprint (usable start + daily quantities), expiring after 10 minutes, so the queue does not call the ML server twice for unchanged history; the forecast route itself is uncached, as before. All v2 calls share a concurrency limit (`ML_V2_CONCURRENCY`, default 4). |
| `lib/replenishment/inputs.js` | Gathers the inputs into one plain, serialisable object from **one coherent snapshot**: a REPEATABLE READ, READ ONLY transaction (or, for draft creation, the transaction holding the seller lock that every writer of these tables takes). Computes the canonical fingerprint (amendment 4). Read-only queries only. |
| `lib/replenishment/engine.js` | **Pure function** `(inputs) → result`: no database, no clock (the planning date is an input), no I/O. All of §3 lives here. It is deterministic and unit-tested with fixed inputs. |
| `lib/replenishment/explain.js` | Deterministic sentence templates built from the engine's trace. No language model. |
| `routes/replenishment.js` | Authentication, pagination and persistence of the shadow log. It contains no arithmetic. |

The engine has a versioned JSON contract. That contract is the seam where a Python planning service, for the later optimiser, could replace or extend it without touching routes or UI.

### 6.2 Non-mutation guarantee

The engine is pure; the loader only reads. The only writes are the recommendation-log insert and, on the seller's request, a draft order. Tests compare the **contents** of the stock, movement, settings, supplier, purchase-order and sales tables (an md5 of every row, ordered), not row counts, before and after the queue, the product result and a scenario; a scenario also leaves the recommendation log unchanged.

### 6.3 Explanation structure

The explanation is ordered steps, each quoting its numbers:

1. Where stock comes from, and its age and limitation.
2. Which forecast was used: method, release, origin, lag and covered days.
3. Demand per horizon, with A1 noted.
4. Which deliveries are counted, and which are not and why.
5. Shortage before the new order could arrive.
6. The order maths: raw need, then the minimum-order adjustment, then the pack adjustment, then cost.
7. Assumptions.
8. Missing information, with the action for each item.

### 6.4 Drafts from a recommendation — amendment 4 (Q9)

The fingerprint `inputs_sha256` is the SHA-256 of the canonical (key-sorted) engine input, which holds: planning date and timezone, stock facts (state, on-hand, count instant and age, tolerance, tracking, reconciliation state and each ambiguous movement), sales since the count, incoming lines, unplaced orders, the selected supplier terms, settings, the forecast's input (history fingerprint, sales-source timezones) and output (status, origin, totals, method, tier, release), and the engine version.

1. The recommendation must belong to the seller, match the `inputs_sha256` the page shows, and be `provisional` with a quantity above zero (else 409 `not_actionable`).
2. The forecast cache is warmed outside the lock.
3. In **one transaction under the seller's advisory lock**: if an order already links this recommendation, it is returned (idempotent retry, 200 `replayed`); otherwise the inputs are gathered again and fingerprinted; a different fingerprint returns 409 `recommendation_stale` with the recomputed (and logged) result and creates nothing; an equal fingerprint creates the draft (Stage 1b line validation, the link's currency, `source_recommendation_id`, a `created` event recording the recommendation).
4. Concurrent requests serialise on the lock; the partial unique index is a second guard (a unique-violation is answered with the existing draft).
5. The draft goes through the unchanged Stage 1b approval rules. Nothing is approved or sent automatically, and nothing changes stock.

## 7. Acceptance examples

The numbers below are asserted by `backend/test/replenishment-engine.test.js` against the implementation. The planning date is day 1 and the forecast lag is 0 unless stated.

| # | Case | Inputs | Expected result |
|---|---|---|---|
| R1 | **Regular sales** (shared model) | S0 55 (last-known, counted yesterday); T7 28, T28 120; 30 incoming, expected D+5; L 10, R 14, SS 10; pack 10, MOQ 20; PKR 2,800 | 7-day demand 28, stock at day 7 = 57. 28-day demand 120, stock at day 28 = 0, **shortage 35** in days 8–28; approximate cover ≈ 20 days (A1). Order usable from day 12; shortage before then 0. Raw 31.86 → **32**; MOQ +0; pack +8 → **40** (PKR 112,000). Status `provisional`, with limitations "stock last-known" and "safety stock is your setting". |
| R2 | **Rare sales** (TSB, under 20% selling days) | S0 1; T7 0.6, T28 2.4; L 10, R 14, SS 1; pack 1, MOQ 1 | Demand 0.6 / 2.4 shown to one decimal. **No cover figure.** Raw 2.14 → **3**. The explanation says the item sells in occasional single units, so the even rate is a rough average, and a single sale can empty stock. |
| R3 | **Insufficient history** | 20 confirmed days | `needs_information: forecast_insufficient_history` ("8 more confirmed days needed"). Stock facts and the Stage 1a manual threshold alert are still shown. No demand numbers and no quantity. |
| R4 | **Stale stock** | Count 12 days old, tolerance 7; other inputs as R1 | `indicative`: projections are labelled "based on a count from 12 days ago", the quantity is marked not actionable, the action is "Record a stock count", and there is no draft button. |
| R5 | **Overdue and undated orders** | S0 8; T7 14, T28 60; 20 overdue + 10 undated incoming; L 7, R 7, SS 0; pack 6, MOQ 12 | Base projection ignores both: shortage within 7 days = 6 units; shortage before arrival 8.19. Raw 15.33 → **16**; MOQ +0; pack +2 → **18**. Alternative "if the overdue and undated deliveries (30) arrive tomorrow": **0**. Warning: "Check with the supplier before ordering again". |
| R6 | **MOQ and pack constraints** | S0 10; T7 7, T28 28; L 7, R 7, SS 0; pack 12, MOQ 24 | Raw 5 → minimum **+19** → 24 → pack +0 → **24**. The explanation shows that 19 of the 24 units come from the supplier's minimum, not from demand. |
| R7 | **Forecast origin 3 days in the past** | As R1 with the lag set to 3 | `indicative` (Q6). 7-day outlook D..D+6, **7 days covered** (forecast days 4–10, demand 29.14); 28-day outlook D..D+24, "**25 days covered** (of 28)". With L 10, R 14: raw 33 → 40, indicative only. With L 14, R 14: `needs_information: horizon_beyond_forecast` (29 > 25). The forecast is never re-dated. |
| R8 | **Lead time missing** | As R1 without a lead time | Demand, stock-at-end and horizon shortage are shown; `needs_information: lead_time_missing` with "Set the lead time for Faisalabad Textile Mills". No quantity. |
| R9 | **Unknown stock** | No verified count, legacy 12 | `needs_information: stock_unverified_only`. Demand is shown; the stock projection and quantity are not. Unknown is never 0. |
| R10 | **Cross-horizon inconsistency** | S0 20; T7 21, T28 18 | Flag `forecast_horizons_inconsistent`. 7-day estimate (3/day): demand 21, shortage 1. 28-day estimate (0.64/day): demand 18, no shortage. `indicative`, warning, **no order quantity**. |
| R11 | **Zero demand** (dormant) | S0 4; T7 = T28 = 0; SS 2 | No cover figure; "No sales are expected in the forecast period. This does not mean stock lasts forever." Order 0 (stock at arrival 4 ≥ SS 2). |
| R12 | **Approved but not sent** | As R1 plus an approved, unsent order for 40 (and a draft for 5) | The suggestion is unchanged (40; not counted as incoming), with warnings "…not marked as ordered — avoid ordering twice". No further draft is offered while they exist. |
| R13 | **Sales since the count** | As R1 with 12 units recorded from a sales file after the count date | Base result as R1 (40), plus the scenario "If the 12 unit(s) sold since the count have already left stock", starting from 43: raw 43.86 → 44 → **50**. Count-date units are listed as ambiguous. |
| E1 | **Delivery on the first day of the window** (amendment 1) | 2/day; S0 20; L 7, R 7, SS 0; pack 1; 10 incoming usable on day 9 | Stock when the order is usable 4; window days 9–15. Every day covered → **0**. |
| E2 | **Delivery midway** (day 12 of 9–15) | As E1, delivery usable on day 12 | End-of-window balance alone would say 0, but stock runs out before the delivery: **2** (binding: before PO). After the order: no shortage, lowest stock 0, 2 at the end. With SS 5 the window end binds: **5**. |
| E3 | **Delivery on the last day** (day 15) | As E1, delivery usable on day 15 | **8** (lowest 0, 8 at the end). Packs of 6: 8 → **12**, end 12. SS 5 does not bind (8 > 5). |
| E4 | **Shortage before arrival stays separate** | 2/day; S0 6; L 7, R 7 | 10 short before the order is usable; quantity **14** (the window only). |
| E5 | **Forecast starts tomorrow** (lag −1) | History confirmed through today | `indicative`; outlook and quantity withheld with an explicit note; planning date unchanged. |
| E7 | **Reconciliation needed** (review round 2) | As R1 with a −2 movement at the count's instant from another source | `indicative`, events listed, no draft; an older actionable recommendation is refused as stale |
| E8 | **Timezone mismatch** (review round 2) | As R1 with sales in America/Los_Angeles, stock in Asia/Karachi | `needs_information: timezone_mismatch`; no outlook or quantity; stock, incoming and forecast totals kept; older recommendation refused as stale |
| E6 | **Minimality** | 300 generated cases | For every case, `raw_units` leaves no daily shortage in the window and ≥ SS at its end, and `raw_units − 1` does not (independent brute-force check). |
| R14 | **Forecast service down** | ML unavailable | `unavailable`, with no forecast numbers and no legacy fallback. Stock, incoming and supplier facts are still shown. |
| R15 | **Isolation and non-mutation** | Another seller's product id; any call | 404 for the other seller. Stock, movement, purchase-order and policy row counts are unchanged after every replenishment call. |

Tests (implemented): engine unit tests for R1–R14 and E1–E8 (27 tests); API tests (16) for the product result, queue, isolation, non-mutation by table contents, scenarios, settings, draft idempotency and concurrency, stale refusal for four kinds of change, lag 3 and lag −1, sales since the count, forecast service down or switched off, and rollback; migration 006 tests; the full suite in three timezones; browser evidence (`docs/evidence/inventory-stage2/`).

## 8. UI states (within the existing Inventory workspace and colours)

**Replenishment tab** (beside Stock, Suppliers and Purchase orders): an action queue.
- **Columns:** product, status chip, shortage within 7/28 days, shortage before arrival, suggested quantity (with "indicative" styling when not actionable), stock basis and age, forecast method and lag, next step.
- **Counts:** across all products.
- **Filters:**
  - Needs information
  - Shortage before arrival
  - Order suggested
  - Indicative
- **States:** loading, error and empty, with no sample data. "Forecast service unavailable" is shown as a banner.

**Product drawer, "Outlook" section:**
- two horizon cards (7 and 28): demand, stock at end, shortage, covered days;
- the "Before a new order arrives" line;
- the order breakdown (raw → minimum +x → packs +y → final, cost);
- incoming split into counted / overdue / undated / approved-not-sent;
- the numbered explanation;
- assumption chips (A1–A4);
- a "Missing information" list with action buttons that link to the count form, supplier terms and the policy form.

**Scenario panel:** sliders and inputs for review days, safety stock, lead time and "include uncertain deliveries". The result is labelled "Scenario — not saved".

"Create draft order" appears only for an actionable `provisional` result (quantity above zero, no unplaced order for the product).

## 9. How this foundation supports later stages (not claimed now)

- **Demand uncertainty (architecture §6B):**
  - The engine consumes demand through one interface, "cumulative demand for day range [a, b]". Stage 2 implements it with point totals and A1.
  - A later validated release can supply scenario paths or calibrated quantiles; the engine then runs per scenario and reports shortage distributions. Safety stock can then move from a seller number to a service-level policy, **only** after calibration is demonstrated on untouched data.
  - The shadow log stores the inputs and outputs needed to evaluate this later.
- **Learned supplier delivery times (§6C):**
  - Lead time enters through one interface, which in Stage 2 returns the seller-entered value.
  - Stage 1b already records `ordered_at`, every promised-arrival revision, `first_receipt_at`, `completed_at`, partial receipts and cancellations.
  - A later model can estimate delivery distributions per supplier, with sample counts. It will treat still-open late orders as censored rather than dropping them, and will be promoted only if it beats the declared lead time on future orders.
- **Optimisation and simulation (§7–8):** the pure-engine contract and versioned inputs allow historical replay in a simulator and a later CP-SAT optimiser behind the same interface.

## 10. Decisions (architect review)

| # | Decision |
|---|---|
| Q1 | Review period default 7 days, editable (1–28), labelled as a default |
| Q2 | Safety stock in seller-set units, default 0, with the limitation disclosed |
| Q3 | Spreading assumption A1 for consistent horizons only; inconsistent horizons get no quantity |
| Q4 | Deliveries usable the day after the expected date, explained |
| Q5 | Lost sales, explicitly stated |
| Q6 | Any positive lag makes the result indicative, with reduced coverage and no draft button. Forecast-age limit 7 days, separate from the stock tolerance. |
| Q7 | Sales-adjusted scenario labelled; a declared feed does not prove deduction — coverage intervals and movement attribution are used, unresolved overlap disclosed |
| Q8 | Pure Node engine with a versioned contract (`replenishment-1`) |
| Q9 | Draft-from-recommendation included, only for actionable provisional recommendations, with the consistency rules (§6.4) |
| Q10 | Recommendation log: engine version in the dedupe identity, scenarios not saved, bounded forecast-call concurrency for the queue |

## 11. Amendments applied

| Amendment | Where |
|---|---|
| 1 — order quantity respects delivery timing; after-order outcome; early / midway / last-day examples | §3.5, §7 E1–E4 |
| 2 — explicit date coverage; lag fixes; lag −1 withheld | §3.1, §7 R7 and E5 |
| 3 — T28 < T7: two independent estimates, warning, no quantity | §3.2, §7 R10 |
| 4 — coherent snapshot, canonical fingerprint, atomic idempotent draft, content-based non-mutation tests | §6.1, §6.2, §6.4 |
| Review round 2 — reconciliation state and sales timezones in the inputs; "usable tomorrow" label | §3.6, §3.7, §6.4, §7 E7–E8 |
