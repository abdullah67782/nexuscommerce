# Forecasting milestone: upload → coverage → history → forecasts → UI

**Branch:** `feature/forecast-v2`, built on `main` with import identity merged.
**Status:** working milestone for architectural review.

**The switch:** v2 is off unless the backend has `FORECAST_V2_ENABLED=true`. When it
is off:

- `/api/forecast/v2/*` returns 404;
- the forecasting page looks exactly as before.

The existing daily chart is unchanged and is shown separately from v2.

## What a seller can do

1. **Upload sales and confirm what the file covers.** The upload page has a
   "This file contains every sale for a period" option, with first and last day,
   and a product scope: all my products, or only the products in this file.
2. **Select a product** on Demand Forecasting.
3. **Get 7-day and 28-day totals** for it in the "Total demand ahead" panel. They are
   built from the product's usable history.
4. **See how each total was made:** the dates it covers, the method, how much
   history was used and which tier that falls in, and why any data counts as missing.
   - The panel shows no daily breakdown, no accuracy figure and no confidence range.

## End-to-end demo (real API, real ML server, real PostgreSQL, real pages)

`backend/scripts/demo-forecast-data.js` generates four files for a Lahore store
(Asia/Karachi days). The data ends yesterday. The four files were uploaded through the
actual upload page, in a browser:

| # | File | Coverage confirmed | Result |
|---|---|---|---|
| 1 | All products, 10 Feb – 7 Aug | all products | 954 rows. One wholesale order of 60 suits was **kept and flagged**. |
| 2 | Without mugs, 8 Aug – 5 Oct | products in the file | 191 rows. |
| 3 | Mug orders, 21 Aug – 5 Oct | none | 114 rows, as recorded days. |
| 4 | No sales, 6–7 Oct | all products | **0 rows**: a zero-transaction import. |

Forecasts as served (`docs/evidence/forecasting-milestone/api_v2_product_*.json`):

| Case | Product | Usable history | Tier / method | 7 days (8–14 Oct) | 28 days (8 Oct – 4 Nov) |
|---|---|---|---|---:|---:|
| Regular | Lawn Suit 3-Piece | 240 confirmed days, sold on 91.1% of them | rule → shared model | 23.3 | 96.6 |
| Rare | Bridal Clutch | 238 confirmed days, sold on 8.3% of them | rule → TSB | 0.60 | 2.41 |
| Missing gap | Ceramic Mug Set | 48 days (46 recorded + 2 confirmed). 8–20 Aug are **unknown** (13 days) and are not filled with zero | average-based | 31.3 | 125.0 |
| Insufficient | Prayer Mat | 20 days | none; "20 of 28 days" | — | — |

Screenshots are in `docs/evidence/forecasting-milestone/`:

- `upload1-coverage-form.png`, `upload2-coverage-form.png`, `upload4-coverage-form.png`;
- `upload1-result.png` … `upload4-result.png`;
- `forecast-regular.png`, `forecast-rare.png`, `forecast-missing-gap.png`, `forecast-insufficient.png`;
- `forecasting-page-regular-with-daily-chart.png`, `m-forecast-rare.png` (mobile);
- `upload-page-after-imports.png`.

To reproduce the demo:

```
node backend/scripts/demo-forecast-data.js <folder>
```

Then upload the files in order with the coverage listed in `manifest.json`.

## Decisions implemented

| Decision | Where |
|---|---|
| 1. New sources default to Asia/Karachi; each source has its own timezone; existing dates are not reinterpreted | `lib/imports.js` `defaultTimezone`; `GET`/`PATCH /api/data/sources` |
| 2. Explicit ISO dates only; ambiguous dates are rejected, with the accepted formats shown | `routes/data.js` (`date_help`); upload result panel |
| 3. Missing quantities rejected; no median imputation; large orders kept and flagged | `routes/data.js` (`flagLargeOrders`); `docs/data-cleaning-requirements.md` |
| 4. Fractional quantities rejected | files and store connect |
| 5. Replay behaviour | unchanged from the approved design; the coverage declaration is part of the fingerprint |
| 6. Zero-transaction imports with confirmed coverage | migration 003; file and store connect |
| 7. v2 loads only approved production artifacts | `ml/v2/registry.py`: manifest plus SHA-256, `.json` only, inside `ml/models_v2`. No pickle, joblib or seller model is imported (tested). |

### Coverage details

Migration 003 is in `lib/coverage.js`. See `docs/import-identity-and-coverage.md`, section E.

- Unknown gaps are kept.
- Zeros are filled only inside confirmed coverage of every source that sold the product.
- A rollback revokes coverage.
- A file with rejected rows cannot be confirmed as complete.

### Method

`ml/v2` is a numpy port of the frozen features, TSB and group rule.

- The rule: rare → TSB; otherwise the shared model.
- Tiers: under 28 days → insufficient; 28–179 → mean of the last 28 days × horizon;
  180 or more → the rule.
- Automatic fine-tuning stays disabled.

## Production models and the one-time evaluation

Full report: `kaggle_training/production_v2/outputs/review.md`.

**Training.** Two shared models (7-day and 28-day totals), using the frozen general
recipe:

- 250 trees, seed 42;
- the 53 development products × 10 M5 stores, up to 2015-05-31.

**Order of work:**

1. A fresh holdout was reserved and documented first: 60 new products, metadata only.
   It excludes all 120 products used or examined before.
2. The models were trained.
3. The evaluation was frozen, with hashes of the models, code and reservation.
4. The evaluation ran **once**, through the app's own `ml/v2` code.

Nothing was tuned afterwards.

**Results** (590 eligible pairs of 600; 24 weekly and 6 four-week windows, Dec 2015 – May 2016):

| Days | v2 rule | Shared model | TSB | 28-day avg |
|---:|---:|---:|---:|---:|
| 7 | **37.77%** | 38.02% | 38.70% | 39.27% |
| 28 | **30.05%** | 30.28% | 31.27% | 31.70% |

These figures are WAPE (lower is better).

- **Bias:** −3.9% at 7 days and −7.4% at 28 days. The forecasts are below actual sales.
- **Per store:** the rule beats or ties the shared model in 19 of 20 store/horizon cells.

## Parity and regression results

- **Parity:** `ml/tests/test_v2_parity.py`
  - Features match the experiment code on 60 synthetic series to 1e-9.
  - 2,040 saved frozen-evaluation forecasts are reproduced. They were made under
    pandas 2.2.2 and numpy 1.26.4; the largest difference is 2.3e-5 units.
  - TSB, groups and routes are identical.
- **Training inputs:** sampled training rows match the app's v2 features. The largest
  difference is 2.2e-7, from pandas rolling rounding.
- **ML suite:** 23 tests (`python -m unittest discover -s tests`): parity, tiers, registry
  refusals and serving fixture. Output in `docs/evidence/forecasting-milestone/ml_tests.txt`.
- **Backend:** **89 / 89** under TZ=UTC, America/Los_Angeles and Asia/Tokyo. There are
  no TODO tests. The suite includes:
  - 15 new coverage, cleaning and v2 tests;
  - upgrade tests for 001 → 002 → 003, the reversals and re-applying.
- **Migration rehearsal:** `scripts/rehearse-migration.js` was run on an old-style
  seeded database: backup → restore → 001+002+003 on the copy → counts and quarantine
  unchanged → **passed**.

## Environment

- **Where the work ran:** training, evaluation and the demo ran in the cloud workspace.
  It used xgboost **3.4.1, built from the official v3.4.1 source tag**, because
  PyPI is blocked there; Python was 3.13.
- **Serving:** the app serves from the Windows venv (Python 3.12.4, numpy 1.26.4,
  xgboost 3.4.1). The model files are portable JSON.
- **Not yet confirmed:** `ml/tests/test_v2_serving.py` has not been run in that venv,
  so the venv's output has not yet been checked against the fixture.

## For review: findings and open questions

1. **The old daily chart contradicts v2 on the same page.**
   - For the demo suit, the legacy UK model predicts about 194 units a day, about
     5,800 over 30 days. Actual sales are about 4 a day, and v2 forecasts 97 over
     28 days.
   - The legacy chart also still shows a "95% range" and an accuracy gauge.
   - It is kept separate, as instructed. A decision is needed: hide or relabel it while
     v2 is on?
2. **The legacy daily path can still serve an untrusted model.** It may still load
   `xgb_finetuned_3.pkl` for seller 3. v2 never does. Gating the legacy loader was not
   in scope.
3. **Under-forecasting and dormant products.**
   - Bias is negative at both horizons.
   - Dormant products have very high percentage error on tiny volume, because they are
     routed to the shared model under the frozen rule.
   - These were reported, not tuned. Any change needs another fresh holdout.
4. **"Recorded" days.** Outside confirmed coverage, a day that has rows is taken as
   complete. This is how all data worked before 003. Days with no rows are unknown.
   Please confirm this is acceptable.
5. **Strict rule across sources.** Zeros are filled only when **every** source that ever
   sold the product covers the day. A product with old file history plus a new connector
   therefore gets no zero-filled days until both sources are covered.
6. **Large-order rule.** The rule (Q3 + 3 × max(IQR, 1), at least 8 rows per product per
   file) is a simple heuristic. It only flags; it never removes.
7. **Forecast start date.** Forecasts start the day after the last known day. If the
   data is stale, the panel says so instead of moving the dates.

## Deferred, as instructed

- Stock-history expansion.
- `replace_period` (advanced overlap replacement).
- Executing the ownership repair (it remains dry-run).
- Unrelated cleanup.

## To do on the development machine

1. Run `node scripts/rehearse-migration.js`, then `npm run migrate`. See
   `docs/migration-runbook.md`.
2. Verify the serving environment: in `ml/`, run `venv\Scripts\python -m unittest tests.test_v2_serving tests.test_v2_parity`.
3. To review v2, add `FORECAST_V2_ENABLED=true` to `backend/.env` and restart the
   backend and ML server.
