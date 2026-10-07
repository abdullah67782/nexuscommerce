# v2 production models: one-time evaluation on a fresh holdout

**Protocol:** `nexus-v2-production-evaluation-20261008-v1` (sha256 `9c30a3e4…758267`)
**Models:** release `nexus-v2-shared-20261008`, in `ml/models_v2/` (manifest sha256 `800ff78e…cd26b`)
**Status:** evaluated once, as frozen. Nothing was tuned or changed after the results.

## Order of work (each step refuses to run twice or out of order)

| Step | Script | What it did |
|---|---|---|
| 1 | `reserve_holdout.py` | Reserved 60 new M5 products (20 per category) by hashing a new seed. It parsed catalog columns only, never sales. It excluded all 120 products used or examined before: 60 original sample candidates (including the 53 development products) and the 60 products of the first holdout. |
| 2 | `train_production.py` | Trained two shared models (7-day and 28-day totals) with the frozen recipe: general model parameters, 250 trees, seed 42. Training used the 53 development products × 10 stores, from launch to 2015-05-31. No holdout product was read. |
| 3 | `freeze_evaluation.py` | Froze the windows, metrics and comparisons, plus hashes of the reservation, models, manifest and every code file the evaluation runs (including the app's `ml/v2`). |
| — | dry run | Ran the evaluator on **previously examined** products (the first holdout, 2 stores) to check that the code runs. No code or setting changed afterwards. |
| 4 | `evaluate_production.py --execute-once` | Ran one evaluation through the application's own code: `ml/v2/registry.load_models` (with hash checks) and `ml/v2/forecast.forecast_totals`. |

## What was measured

- **Period:** forecasts from 2015-12-01. That gives 24 weekly windows (the last ends 2016-05-16) and six four-week windows (the last ends 2016-05-16).
- **Coverage:** 600 store/product pairs, of which **590 were eligible**. To be eligible, a pair needed a first recorded price at least 180 days before the training cutoff. The 10 excluded pairs are listed in `eligibility_all_pairs.csv`; seven of them are one product that launched after the cutoff. No pair was replaced.
- **Inputs:** each forecast used only that pair's sales before the window.
- **Metric:** WAPE = total absolute error ÷ total actual sales × 100, pooled over all windows and pairs. Lower is better.

  A WAPE of 38% does **not** mean "62% accurate" for a product.

## Results

| Days ahead | v2 rule (as served) | Shared model alone | TSB alone | 28-day average × days |
|---:|---:|---:|---:|---:|
| 7 | **37.77%** | 38.02% | 38.70% | 39.27% |
| 28 | **30.05%** | 30.28% | 31.27% | 31.70% |

- **Bias** (rule): −3.9% for 7 days and −7.4% for 28 days. The forecasts were **below** actual sales on average. The shared model alone is also low: −3.0% and −6.2%.
- **By store** (10 stores × 2 horizons = 20 comparisons):
  - The rule beat or tied the shared model in 19 of 20. The exception is TX_2 at 28 days: 30.58% vs 30.31%.
  - The rule beat the 28-day average in 19 of 20. The exception is WI_3 at 28 days: 32.44% vs 31.77%.
  - Details are in `metrics_by_store.csv`.
- **Post-hoc** (not part of the frozen protocol): a product-level resampling of the change in absolute error, in `posthoc_product_bootstrap.csv`.

  | Comparison | 7 days | 28 days |
  |---|---|---|
  | Rule vs shared model | −0.65% [−1.22, −0.31] | −0.77% [−1.78, −0.11] |
  | Rule vs 28-day average | −3.82% [−5.77, −1.93] | −5.22% [−7.40, −2.70] |

  These are descriptive intervals over 60 products in one retail chain, not a guarantee.

### By sales pattern

Groups are recomputed at each forecast from the previous 180 days.

| Group | Share of actual units | Method served | 7-day WAPE (served) | 28-day WAPE (served) | 28-day average, for reference (7 / 28) |
|---|---:|---|---:|---:|---:|
| Regular | 41% | shared model | 29.66% | 22.73% | 31.23% / 24.10% |
| Occasional | 56% | shared model | 41.16% | 33.22% | 42.77% / 35.40% |
| Rare | 3% | TSB | 83.13% | 64.16% | 83.52% / 62.67% |
| Dormant | 0.1% | shared model | 238.65% | 178.54% | 100% / 100% |

Findings to keep visible (reported, not acted on):

- **Rare products:** errors are still very high. TSB is better than the shared model for them (83.1% vs 91.3% for 7 days; 64.2% vs 72.0% for 28 days). For 28 days, the plain average was slightly better still (62.7%).
- **Dormant products:** no sales in the last 180 days. The shared model forecasts small positive totals, and almost no units actually sold, so the percentage error is large. The tiny volume (0.1%) barely moves the total. The frozen rule routes dormant products to the shared model. Changing that would need a new holdout.
- **Under-forecasting:** both horizons forecast too low, more so at 28 days.

## Environment and parity

- **Training and evaluation environment:**
  - Python 3.13.16, pandas 3.0.5, numpy 2.5.3;
  - **xgboost 3.4.1**, built from the official v3.4.1 source tag — the same version the app pins.
- **Checks that the training inputs match the app's inputs:**
  - 300 sampled training rows per horizon were recomputed with the app's v2 feature code. The largest difference was 2.2e-7, from pandas rolling-window rounding.
  - `ml/tests/test_v2_parity.py` reproduces 2,040 saved forecasts of the earlier frozen evaluation, which ran under pandas 2.2.2 and numpy 1.26.4. The largest difference was 2.3e-5 units.
- **Serving check:** `ml/tests/test_v2_serving.py` replays fixed forecasts from these models (`ml/tests/fixtures/v2_serving_fixture.json`). Run it once in the app's Windows venv before relying on v2.

## Limits

- **Scope:** unseen products from the same US retail chain (M5). This is not validation on a Pakistan store, another country or an independent business.
- **No uncertainty:** no interval or "confidence" is claimed. Accuracy figures are not shown in the app.
- **Stockouts:** zero sales may reflect stockouts, which are unknown in M5. A launch is approximated by the first recorded price.
- **Reruns:** this holdout has now been used. Any change to the models, the rule, tiers or thresholds needs another fresh holdout.
