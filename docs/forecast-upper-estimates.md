# Upper demand estimates (upper-estimates-1)

Status: **implemented, tested and switched on in the owner's development environment on 2026-10-13** (migrations 007 + 008 applied; laptop smoke test 27/27). It is waiting for browser evidence and the activation review. The forecast, its routing and its point predictions are unchanged. Reorder suggestions and seller-set safety stock do not use these estimates. AI purchasing protection stays research-only (amendment F1).

## 1. What the seller sees

The forecasting page shows the existing 7- and 28-day forecast. Below it, where the policy allows, it shows **one 80% or one 90% upper demand estimate**; the seller picks the level. For each horizon the page shows:

- the dates;
- the upper estimate and the forecast for the same days (the forecast is unchanged);
- the method and its code (U0–U3);
- the benchmark coverage, e.g. "actual demand was at or below this estimate in 79.2% of 2,064 windows from 118 products × stores; target 80%, accepted within ±5 points";
- the limitations. The first is always "**Evaluated on US Walmart benchmark data; not calibrated to your store.**"

It is never shown as a range: there is no lower estimate, and the forecast is not used as a lower bound. It is not a guarantee and not an order quantity.

**Two honest notes appear when they apply:**

1. **Estimate below the forecast.** This happens for irregular sellers. The forecast is an average, while the estimate is the level demand stayed at or below in most benchmark windows.
2. **90% estimate below the 80% estimate.** This happens because each level uses its own evaluated method, and neither is adjusted. It was seen in 1 of 244 development cases.

## 2. Approved cells and methods

Approved cells are the 12 that passed the final evaluation; other cells are never served. Benchmark figures are from `kaggle_training/stage3/outputs/final_results/evaluation/us_totals_cells.json`.

| Pattern | 7 days 80% | 7 days 90% | 28 days 80% | 28 days 90% |
|---|---|---|---|---|
| Regular | U0 · 0.792 | U0 · 0.903 | U0 · 0.816 | U0 · 0.908 |
| Occasional | U2 · 0.793 | U0 · 0.894 | U0 · 0.799 | U0 · 0.905 |
| Rare | U3 · 0.810 | U3 · 0.878 | U0 · 0.790 | U1 · 0.888 |

Methods (F = the forecast total; parameters copied byte-for-byte from the frozen calibration):

| Code | Method | Formula |
|---|---|---|
| U0 | Forecast-error ratio | max(0, (F + 1) × q₀ − 1) |
| U1 | Conformal score | max(0, F + q₁ × √(F + 1)) |
| U2 | Quantile model with conformal correction | max(0, (b(x) + c) × (F + 1) − 1). Uses the stored 7-day 80% booster and the frozen correction. |
| U3 | Rare-sales simulation | TSB bootstrap, 400 draws. Seeded from the request, so the same history always gives the same estimate. |

## 3. Applicability policy upper-estimates-policy-1

The server checks these conditions in order. Each failure returns a reason that is shown to the seller, and the forecast is still shown.

| # | Condition | Where | Reason code |
|---|---|---|---|
| 1 | `FORECAST_UPPER_ESTIMATES_ENABLED=true` (and `FORECAST_V2_ENABLED=true`) | backend | `disabled` (the panel is hidden) |
| 2 | Store country confirmed by the seller (Inventory → Calendar); never inferred from a timezone | backend | `country_not_confirmed` |
| 3 | Country = US | backend | `market_pakistan` / `market_not_evaluated` |
| 4 | The seller confirmed the profile `us_general_retail`: a US store selling individual units of food, household or hobby products, and the estimates are not calibrated to the store. Can be withdrawn. | backend | `profile_not_confirmed` / `profile_withdrawn` |
| 5 | Product placed in a benchmark department: food, household or hobbies | backend | `product_type_not_set` / `product_type_not_covered` |
| 6 | A forecast exists; ≥ 180 confirmed days (model tier) | ML | `no_forecast` / `short_history` |
| 7 | Pattern is regular, occasional or rare (not dormant) | ML | `dormant` |
| 8 | Model release = `nexus-v2-shared-20261008` (the evaluated release); route as evaluated | ML | `release_not_evaluated` / `route_not_evaluated` |
| – | ML service or artifacts unavailable | backend | `service_unavailable` (the forecast is not affected) |

Answers are stored per seller in migration 008:
- `upper_estimate_settings` and `upper_estimate_product_types`, both versioned;
- `upper_estimate_events`, append-only.

A product type can only be recorded for the seller's own product, enforced by a foreign key on (product, seller).

## 4. Artifacts and code

| Path | What |
|---|---|
| `ml/upper_estimates_v1/manifest.json` | Hashes of the 3 files below; version and policy; evaluated release; xgboost 3.4.1 |
| `ml/upper_estimates_v1/calibration_us.json` | = frozen laptop calibration `fc73f5d2…` (manifest v2) |
| `ml/upper_estimates_v1/U2_h7_p0.8.json` | = selected booster `2153c5d9…` (protocol v1) |
| `ml/upper_estimates_v1/policy.json` | The 12 cells, methods, parameters and benchmark figures. Built from the consumed final evaluation (checksum list `16d1d9a6…`) by `kaggle_training/stage3/final/build_upper_estimates_artifacts.py`. |
| `ml/v2/upper_estimates.py`, `POST /v2/upper-estimates` | Hash-checked loading; every policy parameter must equal the frozen calibration; the forecast is returned unchanged. |
| `backend/lib/upperEstimates.js`, `routes/forecast.js` | `GET /api/forecast/v2/:id/upper-estimates`; `GET`/`PUT /api/forecast/upper-estimates/settings`; `PUT /api/forecast/upper-estimates/products/:id` |
| `frontend/src/components/forecast/UpperEstimates.jsx` | The panel on the forecasting page |

## 5. Tests and evidence

| Check | Where | Result |
|---|---|---|
| Artifact-to-API parity on 122 development cases covering all 12 cells, against the frozen research code (fixture from `make_upper_estimates_fixture.py`) | `ml/tests/test_upper_estimates.py` | **Cloud (NumPy 2.5):** U3 exact; U0/U1/U2 relative difference < 1e-6, explained by NumPy 2 float32 arithmetic in the served forecast; the strict check is skipped there. **Laptop runtime (NumPy 1.26.4), 2026-10-13: strict check passed.** Worst \|ΔF\| 1.4e-14; worst \|Δ upper\| U0 2.8e-14, U1 0, U2 3.6e-15, U3 0. The endpoint test was skipped because the FastAPI test client is not installed. |
| Integrity: changed file, changed parameter, extra cell | same | Each refused |
| Eligibility boundaries: 27/179/180 days; 144/143/36/35 selling days of 180; dormant; release and route | same | Pass; the forecast equals `/v2/forecast` in every case |
| Policy order, versions, append-only events, Pakistan refusal, withdrawal | `backend/test/upper-estimates.test.js` | Pass |
| Fallback: ML failure → `service_unavailable`; forecast response unchanged | same | Pass |
| Seller isolation: another seller's product → 404; answers per seller; FK refuses cross-seller rows | same, plus `upgrade008.test.js` | Pass |
| Separate from replenishment: answers and estimates never change a fingerprint or quantity | same, plus smoke | Pass |
| Migration 008: no existing row changes; rules; refuses reversal once answers exist | `backend/test/upgrade008.test.js` | Pass |
| End to end with the real ML code (cloud) | `backend/scripts/smoke-stage3.js` | **27/27** (`docs/evidence/inventory-stage3/smoke_stage3_cloud.txt`) |

The full backend suite passes **219/219**.

**Frontend (laptop), 2026-10-13:**
- `npm run build` passed.
- ESLint is clean for `UpperEstimates.jsx`, `CalendarTab.jsx` and `Outlook.jsx`: their first loads now set state only in request callbacks, and the outlook panel is keyed by product.
- Project-wide lint still reports earlier errors in other files, for example the legacy forecasting page and `inventory/page.jsx`. These are unrelated to this release and were left unchanged.

## 6. Activation (owner's laptop)

1. Run `python -m unittest tests.test_upper_estimates -v` in `ml\` with `ml\venv`. The strict parity check must pass, not be skipped.
2. Rehearse and apply migrations 007 and 008 (`docs/migration-runbook.md`).
3. Set `FORECAST_UPPER_ESTIMATES_ENABLED=true` and `INVENTORY_CALENDAR_ENABLED=true` in `backend\.env`, then restart the ML server and the backend.
4. Run `node scripts/smoke-stage3.js` (expect all checks to pass) and capture browser evidence (§7).

**Rollback:** set `FORECAST_UPPER_ESTIMATES_ENABLED=false`. The panel disappears and the forecast is unaffected. The answers stay in the database.

## 7. Browser evidence to capture

Capture at phone (≈390 px), tablet (≈768 px) and desktop widths:

1. The forecasting page for an eligible regular product, with 80% selected.
2. The same page with 90% selected.
3. A rare product.
4. A dormant or short-history product, showing its reason.
5. The store-profile confirmation step.
6. The product-department step.
7. The Calendar tab, showing holidays with "Effect unknown" and entries labelled "Assumed by you", "Closure declared by you" and "Supplier delay declared by you".
8. The Replenishment outlook with those labels.
