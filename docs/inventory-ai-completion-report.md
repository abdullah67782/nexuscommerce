# Inventory AI module — completion report (2026-10-14)

**Scope.** The **staged operational release** (Stages 1a–3 as approved) is complete. Six further architecture items were not built. They are recorded as future extensions in `docs/inventory-ai-future-extensions.md` and do not keep this module open (owner decision, 2026-10-14).

**Review follow-up (Codex review of `0ef3572`):**
- **Supplier performance.** An order cancelled after a partial receipt is no longer counted as a completed or on-time delivery. Delivery needs the full ordered quantity. Such orders are kept apart (`cancelled_after_partial`) and stay outside the lead-time statistics and the learned estimate. Covered by a regression test.
- **Stock-out flags.** "Out of stock by your records" now needs every day to be a confirmed day with no sales, and no stock added by any other movement before the receipt. Unknown days never count as zero. The wording is qualified ("may understate demand"). Covered by a regression test.
- **Tests.** Every test now starts with all feature switches off and sets its own. The suite gives 233/233 with or without the development switches in the environment.
- **Evidence.** The missing `parity_sample.jsonl` was restored from the completed run's own output folder; nothing was rerun.
- **Wording.** The sequential outcome now reads "no candidate demonstrated superiority under the frozen comparison".

The owner directed the module's completion. Codex was the architect and reviewer; Claude implemented. The full feature-by-feature reconciliation against the architecture is in `docs/inventory-ai-feature-checklist.md`.

## Delivered (enabled)

- **Stock ledger:**
  - counts, movements and count files with rollback;
  - unknown is never treated as 0;
  - seller isolation.
- **Purchasing:**
  - suppliers and product terms;
  - draft → approve → order → partial receipt → correction / return;
  - only receipts change stock.
- **Forecast integration (unchanged models):**
  - confirmed history only;
  - stock-out flags (never imputed);
  - events in the forecast period labelled.
- **Calendar and events:**
  - country confirmed by the seller;
  - holidays labelled "Effect unknown";
  - closures, supplier delays and demand changes, labelled as declared or assumed by the seller;
  - used by `replenishment-2`.
- **Uncertainty:** one-sided 80/90% upper estimates (benchmark reference), behind the server-side applicability policy.
- **Replenishment:**
  - deterministic engine, queue, outlook and scenarios;
  - stale-recommendation refusal;
  - one draft per recommendation.
- **Supplier intelligence:**
  - delivery performance;
  - timestamp quality;
  - declared lead times and delay scenarios.

## Data-dependent or research outcomes (explicitly not production features)

| Capability | State |
|---|---|
| Learned supplier delivery estimate | **Needs seller data.** It shows a readiness state until there are ≥ 8 valid deliveries **and** a forward check beats the declared lead time. It is display-only. |
| AI purchasing protection | **Research only.** The one-time final evaluation found that no cell passed: no candidate demonstrated superiority over the seller-set safety stock under the frozen comparison (G4; short history also G1). It is not integrated. See `docs/inventory-stage3-sequential-results.md`. |
| Learned event effects (US, Pakistan) | Research only; they failed the final evaluation (`docs/inventory-stage3-final-results.md`) |
| Two-sided ranges, daily paths | Not built: not validated |
| Budget optimiser, anomaly detection, excess-stock advice, assistant, outcomes view, reject / snooze | **Unbuilt — future extensions** (`docs/inventory-ai-future-extensions.md`), outside the delivered module (owner decision, 2026-10-14). |

## Verification

| Check | Result |
|---|---|
| Backend tests | 233 / 233 (also with the development switches set: tests control their own switches), including the full seller journey: upload → count → supplier → forecast / events → advice → draft → approval → partial receipt → correction / return → stock, plus isolation, ML down, insufficient data and rollback |
| ML | v2 serving parity; upper-estimate strict parity on the laptop (2.8e-14) |
| Smoke (laptop, real ML) | `smoke-stage3` 27/27; `smoke-replenishment` 23/23 |
| Frontend | Production build; ESLint-clean module files |
| Browser evidence | 33 screens (phone / tablet / desktop); no page scrolls sideways (`docs/evidence/inventory-stage3/browser-evidence.md`) |
| Migrations 001–008 | Rehearsed (backup, scratch copy, verified counts) and applied on development |
| Sequential evaluation | Frozen protocol `87578ccc…`, executed once; engine parity 3,005 / 3,005 |

## Operation and rollback

See `docs/inventory-ai-operations.md` (services, switches, migrations, rollback by feature, checks and missing-data behaviour) and `docs/migration-runbook.md`.

## Governance notes

- The sequential protocol was frozen on the owner's instruction while the architect's clearance was still pending. This is recorded in the protocol (`governance.clearance`).
- Forecast models, routing and colours are unchanged.
- Manual training stays disabled, and ownership repair stays dry-run only.
