# Step 2: earlier rolling practice tests

Completed on the local CPU in 4.96 minutes. Compared six methods across three stores, three historical training cutoffs and two forecast horizons. The 53 development products are separate from all 60 reserved products across all stores.

| Training ends | Practice period | Weekly windows | Four-week windows |
|---|---|---:|---:|
| December 31, 2014 | January-March 2015 | 12 | 3 |
| March 31, 2015 | April-May 2015 | 8 | 2 |
| May 31, 2015 | June-August 2015 | 13 | 3 |

Models remain fixed inside each period. Each forecast uses actual history available before its starting date. Forecast windows do not overlap within a horizon. Sales groups are recomputed from the latest available 180 days. Products require 56 consecutive previous days; insufficient-history exclusions are recorded in `history_exclusions.csv` before inspecting forecast outcomes.

## Results in easy words

The general model beats both simple average methods in every one of the nine weekly store-period comparisons. It is a useful candidate for the next steps. Adding store-specific training is not a dependable improvement: it improves weekly results in six of nine comparisons, generally by very little, and worsens California results substantially in spring and summer. Four-week personalization improves four of nine comparisons and also sometimes hurts.

The table combines absolute errors across all three practice periods. Lower WAPE is better. WAPE is total absolute forecast error divided by total actual sales; it is not an accuracy percentage or a promise for an individual product.

| Store | Days ahead | General WAPE | Personalized WAPE | 28-day average WAPE | TSB WAPE |
|---|---:|---:|---:|---:|---:|
| California | 7 | 40.95% | 42.52% | 45.22% | 42.21% |
| Texas | 7 | 42.51% | 42.34% | 43.77% | 42.65% |
| Wisconsin | 7 | 41.73% | 41.62% | 45.17% | 42.35% |
| California | 28 | 38.39% | 39.60% | 39.25% | 40.15% |
| Texas | 28 | 38.16% | 38.13% | 38.04% | 35.50% |
| Wisconsin | 28 | 37.06% | 37.60% | 37.82% | 36.81% |

TSB, which tracks how often a product sells and its quantity when it sells, performs competitively for four-week totals in Texas and Wisconsin. No routing decisions have been made from these results. The next step is to examine regular, occasional and rare sellers separately before designing a cautious selection rule.

## Verification and limitations

Eleven unit tests passed. Recomputed 144 saved metric rows from 39,114 prediction rows. Reloaded all 36 exported models and verified 250 general or 330 personalized trees. Verified zero reserved-product overlap and unchanged hashes for all 18 existing runtime artifacts. See `verification.json` and `source_snapshot.json` for the audit.

These are development checks using an already selected cohort. Summer repeats a previously examined calibration period. Four-week forecasts have only eight windows per store, so the evidence is limited. Stores are from the same US retail chain; this does not establish transfer to other countries or independent businesses. This experiment forecasts observed sales and cannot identify lost sales during stockouts. The application still uses its existing runtime models; these experiments do not yet improve deployed forecasts.
