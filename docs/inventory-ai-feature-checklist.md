# Inventory AI — feature checklist against the agreed architecture

Reconciliation of `docs/inventory-ai-architecture-proposal.md` (§4–§11) and the approved stage plans (Stage 1 plan, Stage 2 design, Stage 3 proposal and decisions) with what is built. Updated 2026-10-14.

**Status legend:**

| Status | Meaning |
|---|---|
| **Enabled** | Works now; deterministic, or evaluated and approved |
| **Needs seller data** | Built and working. It shows a readiness state until the seller's own records exist. |
| **Reference (benchmark)** | Shown with its evidence label; not calibrated to the store |
| **Research only** | Evaluated; not offered as a feature |
| **Pending** | Waiting for clearance or evidence (listed in §11) |
| **Not approved** | In the architecture but never part of an approved stage. Recorded, not silently dropped; needs an owner decision. |

## 1. Stock foundation (architecture §4; Stage 1a)

| Feature | Status | Where / evidence |
|---|---|---|
| One default location per seller; discrete units | Enabled | Migration 004 |
| Stock counts (absolute, timed, verified), idempotent, supersede rule, count files with rollback | Enabled | `routes/inventory.js`, `lib/stockLedger.js`; Stage 1a report |
| Movements ledger (shipment, customer return, damage, found, correction; append-only) | Enabled | Migration 004 |
| `on_hand` = latest verified count + later movements; never stored; unknown ≠ 0 | Enabled | `stockLedger.positions` |
| Legacy stock kept as unverified evidence | Enabled | `inventory_legacy_rows` |
| Sales uploads never write stock | Enabled | D1 |
| Reconciliation flag (events at the count instant) | Enabled | Stage 2 review fix 1 |
| Readiness and fallback contract (§5): missing / stale stock, history tiers, ML unavailable, zero demand, inbound completeness | Enabled | `/inventory/items` readiness; journey tests |
| Commitments / reservations | Not approved as a feature: reported as `not_tracked` (D7) | No order feed exists |
| Seller isolation (composite foreign keys, 404 for others) | Enabled | access, purchasing and journey tests |

## 2. Purchasing (Stage 1b)

| Feature | Status | Where / evidence |
|---|---|---|
| Suppliers; product terms (cost with currency, lead time, MOQ, pack, preferred) | Enabled | Migration 005 |
| Declared slowest lead time (delay scenario) | Enabled | Migration 007 `lead_time_max_days` |
| Purchase orders: draft → approved → ordered → partial → received / cancelled; versions; append-only events | Enabled | `routes/purchasing.js` |
| Receipts (idempotent), corrections, supplier returns; later count authoritative | Enabled | purchasing and journey tests |
| Approval never changes stock; only receipts do | Enabled | Journey test (on-hand 20 after approval) |
| Pack / MOQ checks at approval; currency checks | Enabled | Stage 1b report |

## 3. Forecast integration

| Feature | Status | Where / evidence |
|---|---|---|
| Frozen v2 7/28-day totals, tiers (28 / 180 days), routing (shared model / TSB / 28-day average) | Enabled (unchanged) | `ml/v2`, forecasting milestone |
| Confirmed-history-only input; unknown days never zero | Enabled | `lib/coverage.js` |
| Forecast lag handling and date coverage | Enabled | Stage 2 amendment 2 |
| T28 < T7 detection (no quantity) | Enabled | Stage 2 amendment 3 |
| Stock-out flags with the forecast (recorded and suspected; never imputed) | Enabled; recorded periods need ledger data | `lib/stockoutFlags.js`; `stockout-events.test.js` |
| Events in the forecast period listed ("effect unknown" / seller labels); forecast unchanged | Enabled | `routes/forecast.js`; test |

## 4. Events and calendar (Stage 3a)

| Feature | Status | Where / evidence |
|---|---|---|
| Country confirmed by the seller (timezone only suggests) | Enabled | `/api/calendar/settings` |
| Holidays (PK and US); Islamic dates expected ±1 day; locally confirmed Eid dates (append-only) | Enabled | `lib/calendar.js` |
| Promotions, closures, supplier delays, seller demand scenarios (versioned, history) | Enabled | Migration 007, `routes/calendar.js` |
| Labels: holidays "Effect unknown"; % changes "Assumed by you"; closures and delays "declared by you" | Enabled | Calendar and engine tests; smoke-stage3 |
| Calendar in replenishment (`replenishment-2`: closures, demand changes, supplier delays, order-by, late-delivery scenario); conflicts withhold the quantity | Enabled (`INVENTORY_CALENDAR_ENABLED=true`) | Engine tests; stale-refusal test |
| Learned event effects (E1c US, E1 Pakistan) | Research only: both **failed** the final evaluation | `docs/inventory-stage3-final-results.md` |

## 5. Uncertainty (architecture §6B; Stage 3)

| Feature | Status | Where / evidence |
|---|---|---|
| One-sided 80/90% upper demand estimates, 12 passing cells (regular, occasional and rare × 7/28 days) | Reference (benchmark), behind the store / product / data applicability policy | `docs/forecast-upper-estimates.md`; laptop strict parity 2.8e-14 |
| Dormant, short history, Pakistan, unsupported store or product | Shows a reason; forecast only | Same |
| Two-sided ranges, daily paths (P1/P2), window quantiles | Not built: not validated | Final results |

## 6. Replenishment (architecture §7; Stage 2)

| Feature | Status | Where / evidence |
|---|---|---|
| Pure engine (daily checkpoints, A1–A4, open orders, lost sales), explanation, assumptions | Enabled | `engine.js` (`replenishment-1`/`-2`) |
| Queue across all products; product outlook; approximate cover; before-arrival shortage | Enabled | Replenishment tab |
| Coherent snapshot + fingerprint; stale refusal; one draft per recommendation (concurrency) | Enabled | Stage 2 tests; journey test |
| Seller-set review period and safety stock | Enabled | Settings |
| AI purchasing protection (suggested safety stock) | Research only: **no cell passed** the one-time final evaluation (G4: the seller's own safety stock gives the same protection with less stock). Not integrated. | `docs/inventory-stage3-sequential-results.md` |

## 7. Scenarios

| Feature | Status | Where / evidence |
|---|---|---|
| Scenario panel (review, safety stock, lead time, uncertain deliveries), "not saved" | Enabled | Stage 2 |
| What-if supplier delay and demand change % (labelled) | Enabled | Calendar tests |
| Late-delivery scenario from the declared slowest time | Enabled | Engine test |
| Named low/base/high demand scenarios with probabilities | Not built: the upper estimates are the evaluated alternative; no claimed probabilities |  |

## 8. Supplier intelligence (architecture §6C)

| Feature | Status | Where / evidence |
|---|---|---|
| Records: ordered_at, promise (at order time and revisions), receipts, completion, cancellations | Enabled | Migration 005 |
| Delivery performance per supplier: delivered day (net of corrections), lead time to first and full receipt, on-time vs promise, late open orders censored, units, returns | Enabled; meaningful once orders exist | `lib/supplierPerformance.js`; Suppliers → supplier |
| Timestamp quality (back-dated orders, late-recorded receipts, impossible dates excluded) | Enabled | Same; tests |
| Declared lead times and delay scenarios | Enabled | Same |
| Learned delivery estimate | **Needs seller data.** Readiness state; enabled only with ≥ 8 valid deliveries **and** a forward-chaining check beating the declared lead time. Display-only; replenishment keeps the declared lead time. | Tests (both outcomes) |

## 9. Simulation and optimisation (architecture §7–§8)

| Feature | Status | Where / evidence |
|---|---|---|
| Historical policy replay (simulator) with the real engine (exact parity) | Built (research tooling) | `kaggle_training/stage3/sequential` |
| Comparison of seller safety stock vs AI protection, shortage vs holding cost | Done (final, one time, 1,498 series) | `docs/inventory-stage3-sequential-results.md` |
| CP-SAT budget / pack / MOQ optimiser, solver status | **Not approved.** Pack and MOQ are enforced deterministically, but there is no budget optimiser. | Owner decision requested |

## 10. Other architecture items

| Feature | Status |
|---|---|
| Inventory anomaly detection (§6D) | **Not approved.** Proposed in this module: deterministic accounting checks only. Awaiting decision. |
| Excess-stock / slow-mover advice (§6E) | **Not approved.** Proposed in this module: deterministic version. Awaiting decision. |
| Grounded assistant (§9) | Not approved (later stage) |
| Outcomes view (§10) | Not approved (later stage). The recommendation log keeps the inputs and outputs needed later. |
| Recommendation decisions (accept / reject / snooze, §10) | Partly: "Create draft" from a recommendation is recorded on the order. Reject / snooze: not approved. |
| Background jobs / async plans (§3) | Not needed at the current scale: bounded concurrency + cache |

## 11. Delivery state

| Item | State | Evidence |
|---|---|---|
| Migrations 001–008 | Rehearsed and applied on the development database (2026-10-13) | |
| Flags | `FORECAST_V2_ENABLED`, `INVENTORY_CALENDAR_ENABLED`, `FORECAST_UPPER_ESTIMATES_ENABLED`: on in development | |
| Backend tests | 232/232 (cloud) | |
| ML tests | Strict parity on the laptop | |
| Frontend | Build passed; release files lint-clean | |
| Smoke | `smoke-stage3` 27/27 (laptop, real ML), `smoke-replenishment` 23/23 | |
| Browser evidence | Captured 2026-10-14: 11 screens × phone / tablet / desktop from the running app (real ML). No page scrolls sideways. Two layout fixes made. | `docs/evidence/inventory-stage3/browser-evidence.md` |
| Sequential final run | Completed once (owner clearance); no cell passed | |
| Commit | Module commit on `feature/inventory-stage1a` (2026-10-14) | |
