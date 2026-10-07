# Weekly and intermittent-sales development experiment

## What changed

Direct XGBoost models forecast the total units in the next 7 or 28 days in one step. They reuse historical-sales features and add earlier selling frequency, nonzero quantity and time since last sale. The target is normalized using the preceding 28-day mean, calculated separately per product/store. A personalized candidate explicitly continues each general model on the target store.

Baselines are previous-7-day average, previous-28-day average, SBA-Croston and TSB. SBA-Croston smooths selling quantities and gaps; TSB smooths selling probability on every day and nonzero quantities when sales occur. Their alpha/beta values were fixed at 0.1 rather than optimized using later outcomes. See the primary papers: [Syntetos/Boylan estimator](https://www.sciencedirect.com/science/article/pii/S0925527305001507) and [Teunter/Syntetos/Babai](https://www.sciencedirect.com/science/article/pii/S0377221711004437).

Training labels end May 31, 2015. Incomplete forward-total labels at the cutoff are dropped. Calibration is June-August and development checking is September-November 2015. No 2016 sales or previous final-test observations are read. This is development work, not a new untouched final benchmark: these earlier validation periods have already been inspected in the project.

## Weekly totals: development results

| Store | General XGBoost | Personalized XGBoost | Best simple average | Selected product routes |
|---|---:|---:|---:|---:|
| CA_1 | 38.24% | 38.23% | 43.77% | 39.50% |
| TX_1 | 42.99% | 43.74% | 48.30% | 45.39% |
| WI_1 | 35.22% | 35.59% | 41.45% | 36.29% |

WAPE is lower-is-better absolute error divided by actual units. These compare the same total-sales target, dates and products. Do not directly compare these weekly percentages with earlier daily errors on different dates. Each weekly development comparison uses 13 non-overlapping windows per item.

## Four-week totals: development results

| Store | General XGBoost | Personalized XGBoost | Best simple average | SBA-Croston | Selected route |
|---|---:|---:|---:|---:|---:|
| CA_1 | 29.30% | 26.72% | 32.43% | 34.64% | 32.43% |
| TX_1 | 31.28% | 33.05% | 36.22% | 29.90% | 29.90% |
| WI_1 | 24.17% | 23.83% | 30.55% | 31.75% | 30.55% |

There are only three four-week windows in calibration and three in checking. Consequently no per-product override is permitted for that horizon. The selected route is the method chosen by earlier calibration, not the best one picked after seeing this table. Best simple average is descriptive only, and does not alter selection.

## Honest conclusions

- Direct weekly/four-week general models beat the two simple averages on these development comparisons in all three stores. This is a promising candidate for stock planning, not a final accuracy guarantee.
- Personalization does not consistently help. Four-week California benefits in this development check; Texas does not. Do not require every seller to use a newly trained model.
- SBA-Croston is useful for Texas four-week totals, but neither intermittent-sales method wins universally.
- Per-product routing was implemented with safeguards: at least eight calibration windows, at least four positive windows and at least 5% relative calibration-error reduction to override a store default. Weekly routing made 91 overrides across 159 series. Despite those safeguards, routed weekly forecasts were worse than the standalone general model in all three development checks. More observations and stability checks are needed before enabling it in the app.
- Rare sellers remain hard: general weekly WAPE is roughly 66-76% for the rare group, compared with lower aggregate errors. A good overall number does not establish accuracy for every product.
- No store selection was changed after checking these results. Existing app models remain unchanged.

## Next recommendation

Preserve the direct total-sales models as candidates. Improve selection stability on earlier rolling windows, consider group-level or blended fallback policies, and retain strong simple methods. Freeze any chosen protocol before evaluating genuinely unused dates, stores or products. Do not optimize using the previously examined M5 final test and still claim it was untouched. Inventory confidence intervals and stockout demand remain separate work.

## Verification and artifacts

Five new correctness tests passed (future-sales isolation, forward label alignment/cutoff, TSB decline, sale-gap alignment and long-horizon fallback). All saved metrics were independently recomputed. Routes match calibration-only decisions. All 12 model JSON files reload with expected 250/330 tree counts. Hashes of all 18 original runtime artifacts remain unchanged.

Files: `metrics.csv`, `pattern_metrics.csv`, `predictions.csv`, `product_routes.csv`, `run_complete.json`, model JSONs and matching schemas in each store folder. This sample has 53 products across 10 M5 stores; three stores are held out in turn. The source-store folds share data and are not independent business or country tests. Zero sales may include stockouts. No prices/promotions, supplier decisions or calibrated intervals are claimed.
