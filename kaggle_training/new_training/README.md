# New store personalization experiment

## Reserved final-evaluation products

`outputs/reserved_final_test/reservation.json` records a fixed metadata-only selection of 60 previously unused M5 products (20 per category). **Exclude every listed item across all stores from future development and source-model training.** Do not inspect their sales or redraw the sample before freezing the evaluation protocol. See the folder's README for usage and limitations. `reserve_final_products.py` refuses to overwrite the reservation; `test_reservation.py` checks metadata-only selection behavior.

## Weekly development experiment

`weekly_forecasting.py` trains direct 7-day/28-day total-sales models and compares general/personalized XGBoost with 7-day/28-day averages, SBA-Croston and TSB. Product routing uses June-August calibration only, then checks September-November 2015. No previously examined final-test sales are read. This is development evidence, not a new untouched final benchmark. Results and limitations are in `outputs/weekly_development/review.md`; existing app models are preserved. Five new checks are in `test_weekly_forecasting.py`.

## Training-only sales-pattern inspection

`analyze_sales_patterns.py` inspects the same M5 sample using sales-day columns only through May 31, 2015. Descriptive groups use each product/store's most recent 180 training days. It writes summaries and an audit manifest to `outputs/m5_sales_patterns/` without fitting or replacing any models. `review.md` contains the findings. Group thresholds are planning heuristics, not promises about forecast accuracy; zero recorded sales do not establish absence of demand or available stock.

## Follow-up experiments

Run these **after** the original store-10 experiment:

1. Import `nexus_additional_stores.ipynb` into Kaggle with the Store Item Demand Forecasting dataset. It repeats the unchanged protocol for predefined stores **1 and 5**. Download `nexus_additional_stores.zip` and the completed notebook.
2. Import `nexus_m5_personalization.ipynb` into Kaggle with M5's sales history, calendar and prices. It uses a seeded catalog subset (up to 20 products per category, then filters for early availability) to keep memory manageable, and predefined target stores **CA_1, TX_1, WI_1**. Download `nexus_m5_personalization.zip` and the completed notebook.

Run them sequentially. Both use CPU, export to separate folders, and preserve existing models. Keep all planned outcomes rather than only successful personalization results. The store folds share data; they are not independent datasets. M5 is a separate US retail benchmark and does not establish cross-country transfer.

The M5 adapter reads source ZIPs directly, converts sales-day columns into dates, and trims pre-launch zeros using first price availability. It preserves observed zero-sale days afterward. It does not use future prices as inputs or infer lost demand during stockouts. Items qualify using availability before the training cutoff, not final-test sales. Product sampling uses seed 42, never test errors.

M5 dates: training through May 2015, validation June-November 2015, final test December 2015-May 22, 2016. The subset is **not** an official full-M5 evaluation. No claimed improvement is guaranteed.

`build_followup_notebooks.py` regenerates the self-contained follow-up notebooks from the shared source. Checks and local small runs validate execution only; the full experiments still run on Kaggle.

## Run on Kaggle

1. Create a notebook and import `nexus_store_personalization.ipynb` (Kaggle's Import Notebook option).
2. Add the **Store Item Demand Forecasting Challenge** competition data. Its training CSV has `date,store,item,sales` columns.
3. Use CPU; this first experiment does not require a GPU. Leave `SMOKE_TEST = False` for real results.
4. Run cells in order. The notebook searches Kaggle inputs for the appropriate `train.csv`.
5. Download `nexus_store_personalization.zip` from notebook outputs after completion. Keep the metrics, manifest and models together.

## What it proves

The general model excludes the target store (default store 10). It learns pooled normalized product histories from other stores through 2016. The personalized candidate continues that model using target-store data through 2016. Both use the same inputs and predict individual products in original unit counts.

January-June 2017 is validation, used to choose one method for each 7/14/30-day horizon. July-December 2017 is the untouched final evaluation. Forecast windows are non-overlapping at the maximum 30-day horizon. Earlier actual observations become available at each new origin, but future actuals never enter a forecast window. Neither model is retrained on validation or test data.

Candidates: general XGBoost, personalized XGBoost, repeating last week's daily sales, and fixed previous-7-day average. Personalization must improve validation WAPE by at least 2% relative to the best alternative to be selected. This is a predefined practical threshold, not a statistical significance test.

Reports contain MAE, RMSE, WAPE, bias, per-product test errors and forecast rows. Zero-sale days remain in evaluation. WAPE gives more weight to high-volume products; inspect the per-product report as well.

## Limits and next steps

- One held-out store is a first experiment, not proof that personalization always improves forecasting. Repeat the predefined protocol across other stores and later use M5 as a separate experiment.
- This dataset does not establish cross-country or independent-business performance, and has no prices, promotions or stock availability.
- Forecasts estimate observed sales, not unmet demand during stockouts. No prediction interval coverage is claimed.
- Settings are deliberately fixed, without Optuna tuning on final test data. If tuning is added, restrict it to training/validation.
- These models have a new feature schema and normalized target. They **must not replace existing app models** until a matching inference adapter is built and tested. Runtime files remain untouched.
- JSON is used for XGBoost model export. Preserve the manifest and package versions. Missing IDs/dates/values or duplicate daily records fail explicitly instead of inventing a cleaning policy.

## Local verification

### Step 6: completed reserved-product final evaluation

The frozen evaluator was run with the authorized `--execute-final` flag. `outputs/reserved_final_results/review.md` records the complete result, including all 180 reserved store/product pairs, ten availability exclusions, 170 eligible histories, six store/horizon comparisons, limitations and audit. `verify_reserved_final.py` recomputes metrics, checks source actuals and past-only groups, replays first/last forecasts and verifies fixed routing and runtime hashes. Do not tune methods on these final outcomes and call the rerun untouched. Application integration is a separate next step.

### Step 5: audit and freeze the final protocol

`freeze_final_protocol.py` packages the already verified development models, code, metadata, rules, dates and hashes in `outputs/frozen_final_protocol`. It refuses to overwrite an existing frozen package. The report is `outputs/step5_readiness/review.md`. This step reads metadata and computes file hashes but does not inspect reserved sales. Synthetic tests verify the frozen evaluator before Step 6. Final eligibility is determined per target-store/product pair using past availability, with every reserved pair reported and no replacement sampling. The fixed personalized comparison uses only earlier development-product training. The final evaluator never fits models or selects methods from reserved errors.

### Step 4: cautious group routing and later development check

Run `ml/venv/Scripts/python.exe kaggle_training/new_training/cautious_routing.py`, then `ml/venv/Scripts/python.exe kaggle_training/new_training/verify_cautious_routing.py`. Outputs in `outputs/cautious_routing` contain the frozen selection, candidate evidence, reconstructed group assignments, later forecasts, metrics and review. Selection uses only January-August practice results. The September-November check is retrospective because those data were previously examined; it is not an untouched final test. Routes require meaningful, consistent group gains and sufficient products/windows, with general fallback and no per-product overrides. Reserved products and application runtime models remain separate.

### Step 3: compare sales groups

Run `ml/venv/Scripts/python.exe kaggle_training/new_training/compare_sales_groups.py` from the project root after Step 2. It reads only saved development predictions and reserved-product IDs. Outputs are in `outputs/sales_group_comparison`: pooled, per-store and per-period group metrics, method comparisons against general, stability counts, coverage and an easy-language review. It trains no models and selects no application methods. Group thresholds are descriptive, based on each origin's past history; products may change groups. Main errors retain zero-sale products, and product-level medians separately report how many zero-total products they omit. Small groups and large errors remain explicit.

### Step 2: rolling practice checks

Run `ml/venv/Scripts/python.exe kaggle_training/new_training/rolling_practice.py` from the project root. Results go into `outputs/rolling_practice`, separately from runtime models and earlier experiments.

Models train through December 2014, March 2015 and May 2015, then forecast January-March, April-May and June-August 2015 respectively. Each fold compares general/personalized direct XGBoost, 7/28-day averages, SBA-Croston and TSB for 7/28-day totals in CA_1, TX_1 and WI_1. Settings remain fixed at 250 general trees plus 80 adaptation trees, with four CPU threads. Models stay fixed within a fold; history and descriptive sales-pattern groups update at each forecast origin. Only complete forecast windows are scored. Products without 56 consecutive previous days are logged explicitly and excluded before their future outcomes are read.

All 60 reserved product IDs are rejected across every store. September-November and the reserved final evaluation are outside this experiment. No methods are selected here. The cohort was already selected for earlier development and summer repeats a prior calibration period, so these results assess development stability rather than provide an untouched accuracy claim. Horizons share observations and stores belong to the same US retail chain.

From the project root, using the existing ML environment:

```powershell
ml/venv/Scripts/python.exe -m unittest discover -s kaggle_training/new_training -p test_pipeline.py -v
ml/venv/Scripts/python.exe kaggle_training/new_training/store_personalization.py --smoke --output "$env:TEMP/nexus-personalization-smoke"
```

Smoke mode runs a small subset and few trees to exercise training, adaptation, validation, final testing and export. **Its scores are not final research results.** The notebook's core code matches `store_personalization.py`; keep them synchronized if editing the experiment.
