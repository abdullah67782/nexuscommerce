# Forecasting milestone: upload → coverage → history → forecasts → UI

**Branch:** `feature/forecast-v2`, built on `main` with import identity merged.
**Status:** working milestone for architectural review.

**Revision 2 (2026-10-08), after review:**

1. With v2 on, v2 is the whole forecasting experience. The legacy daily predictions,
   accuracy gauge, "95%" ranges, horizon control, Generate button, CSV exports,
   forecast-vs-actual and training card are not rendered, and the legacy endpoints are
   not called. The overview shows "Forecast v2" instead of model accuracy.
2. Only **confirmed** days count as forecasting history. Records outside confirmation
   stay visible but are reported as "not confirmed". Sellers can confirm stored uploads
   afterwards (Upload history → Confirm period).

The trained models, the routing rule and the evaluation are unchanged; the frozen file
hashes still verify.

**The switch:** v2 is off unless the backend has `FORECAST_V2_ENABLED=true`. When it
is off:

- `/api/forecast/v2/*` returns 404;
- the forecasting page is the unchanged legacy implementation (kept for rollback;
  `f1-flag-off-legacy-page.png`).

## What a seller can do

1. **Upload sales and confirm what the file covers** — while uploading ("This file
   contains every sale for a period"), or later for a stored upload or store sync
   (Upload history → Confirm period). Scope: all my products, or only the products in
   the upload.
2. **Select a product** on Demand Forecasting.
3. **Get 7-day and 28-day totals**, built only from the product's consecutive
   **confirmed** days.
4. **See how each total was made:** dates, method, confirmed history and tier, and
   which days are not confirmed or have no records, and why they don't count.
   - No daily breakdown, accuracy figure or confidence range anywhere on the page.

## End-to-end demo of the corrected flow (real API, ML server, PostgreSQL, pages)

`backend/scripts/demo-forecast-data.js` generates the data for a Lahore store
(Asia/Karachi days, ending yesterday). The four files were uploaded through the
upload page in a browser, then a connected store sync was sent to
`POST /api/store/connect`:

| # | Upload | Confirmed at upload | Rows |
|---|---|---|---:|
| 1 | All products, 10 Feb – 7 Aug | all products | 991 (one 60-suit order kept and flagged) |
| 2 | Without mugs, 8 Aug – 5 Oct | products in the file | 219 |
| 3 | Mug orders, 21 Aug – 5 Oct | **no** | 102 |
| 4 | No sales, 6–7 Oct | all products | **0** (zero-transaction import) |
| 5 | Daraz store sync: Pashmina Shawl, 9 Apr – 5 Oct (180 days) | **no** | 371 |

**Before confirming** (`b1`, `b2`):

| Product | Records | Confirmed history | Result |
|---|---|---|---|
| Pashmina Shawl | 180 days with sales | **0** | "History needs confirmation" — no forecast; nothing sent to the model. Its 737 units still show in sales. |
| Ceramic Mug Set | 46 recent days not confirmed | 2 (6–7 Oct) | insufficient; notes list the unconfirmed period |

**The seller confirms versions #5 and #3** from Upload history (`c1`–`c4`).

**After** (`docs/evidence/forecasting-milestone/api_results.json`):

| Case | Product | Confirmed history | Tier / method | 7 days | 28 days |
|---|---|---|---|---:|---:|
| Regular | Lawn Suit 3-Piece | 240 days (10 Feb – 7 Oct), sold on 94.4% | rule → shared model | 36.0 | 148.1 |
| Rare | Bridal Clutch | 238 days, sold on 7.2% | rule → TSB | 0.1 | 0.6 |
| Missing gap | Ceramic Mug Set | 48 days after a 13-day gap with no records (unknown, not zero) | average-based | 27.2 | 109.0 |
| Insufficient | Prayer Mat | 20 days | none ("20 of 28") | — | — |
| Confirmed later | Pashmina Shawl | 180 days (to 5 Oct; the store did not confirm 6–7 Oct) | rule → shared model | 28.7 | 107.9 |

Forecast dates start the day after the confirmed history (8 Oct; 6 Oct for the shawl,
with a note saying why).

Screenshots in `docs/evidence/forecasting-milestone/`: `a1`–`a4` upload results,
`b1`/`b2` before confirmation, `c1`–`c4` confirming from Upload history, `d1`–`d5` the
five cases after, `e1` the full v2 forecasting page, `e2` mobile, `e3` overview, `f1`
the legacy page with the flag off. `v2_page_legacy_absent.txt` records that, with v2 on,
none of "Generate forecast", "95%", "Export CSV", "Accuracy", "Horizon" appear and no
legacy forecast endpoint is called.

To reproduce:

```
node backend/scripts/demo-forecast-data.js <folder>
```

Then upload files 1–4 with the coverage in `manifest.json`, send file 5 to
`POST /api/store/connect`, and confirm versions #5 and #3 from Upload history.

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

- Forecasting history = consecutive **confirmed** days only (revision 2). Unconfirmed
  records stay visible but do not count; days with no records are unknown, never zero.
- Zeros are filled only inside confirmed coverage of every source that sold the product.
- Stored uploads can be confirmed afterwards: `POST /api/data/uploads/:id/coverage`.
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
- **Backend:** **92 / 92** under TZ=UTC, America/Los_Angeles and Asia/Tokyo (revision 2).
  There are no TODO tests. The suite includes:
  - 18 coverage, cleaning and v2 tests, among them the reported case (180 unconfirmed
    recorded days → 0 usable days, `needs_confirmation`, nothing sent to the model) and
    confirming a stored upload;
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
- **Confirmed by the user (2026-10-08):** the serving and parity checks pass in the
  Windows venv.

## Local verification on the development machine (2026-10-08)

- **Migration:** `scripts/rehearse-migration.js` against a backup of the real development database
  (`nexuscommerce`: 4 users, 7 products, 623 sales, 10,372 units).
  - First attempt failed on the script's own check: that database predates the
    `attributed_sales` view. The check now counts the rule directly (commit `d803e39`).
  - Second attempt: **REHEARSAL PASSED**.
  - Then `npm run migrate` applied 001, 002 and 003; `migrate:status` shows all applied.
  - Backup kept in `backend/backups/`.
- **Serving:** the Windows venv serving and parity checks pass (run by the user).
- **Live flow:** the local app (backend, ML server, PostgreSQL 18, `FORECAST_V2_ENABLED=true`)
  was run through the API with a separate test seller (`v2test@nexus.local`), using the demo
  data. The results are identical to the cloud demo:
  - Pashmina Shawl (store sync, unconfirmed): `needs_confirmation`, 0 usable days.
  - Ceramic Mug Set (unconfirmed upload): 2 usable days, insufficient.
  - After confirming both stored imports:
    - Shawl: 180 days → shared model, 28.7 / 107.9.
    - Mug: 48 days → average, 27.3 / 109.0.
  - Lawn Suit: 240 days → shared model, 36.0 / 148.1.
  - Bridal Clutch: 238 days → TSB, 0.1 / 0.6.
  - Prayer Mat: 20 days → insufficient.
  - Models release `nexus-v2-shared-20261008`, loaded by the Windows ML server.
- **Not yet checked locally:** the UI pages in a normal browser on the local machine.
  The browser panel used here blocks the page's calls to `localhost:5000`. The same pages
  were verified end to end in the cloud demo.

## For review: findings and open questions

1. **Resolved in revision 2:** with v2 on, the legacy daily chart, accuracy gauge,
   95% ranges, controls and exports are no longer shown.
2. **The legacy daily path can still serve an untrusted model** when the flag is off
   (rollback). It may still load `xgb_finetuned_3.pkl` for seller 3. v2 never does.
3. **Under-forecasting and dormant products.**
   - Bias is negative at both horizons.
   - Dormant products have very high percentage error on tiny volume, because they are
     routed to the shared model under the frozen rule.
   - These were reported, not tuned. Any change needs another fresh holdout.
4. **Resolved in revision 2:** records without confirmation no longer count as
   history. Legacy rows with no import record (seeded data) cannot be confirmed; their
   sellers need to re-upload those periods with confirmation.
5. **Strict rule across sources.** Zeros are filled only when **every** source that ever
   sold the product covers the day. A product with old file history plus a new connector
   therefore gets no zero-filled days until both sources are covered.
6. **Large-order rule.** The rule (Q3 + 3 × max(IQR, 1), at least 8 rows per product per
   file) is a simple heuristic. It only flags; it never removes.
7. **Forecast start date.** Forecasts start the day after the last confirmed day. If the
   data is stale, the panel says so instead of moving the dates.

## Deferred, as instructed

- Stock-history expansion.
- `replace_period` (advanced overlap replacement).
- Executing the ownership repair (it remains dry-run).
- Unrelated cleanup.

## To do on the development machine

1. Run `node scripts/rehearse-migration.js`, then `npm run migrate`. See
   `docs/migration-runbook.md`.
2. (Done.) Serving check in the Windows venv.
3. To review v2, add `FORECAST_V2_ENABLED=true` to `backend/.env` and restart the
   backend and ML server.
