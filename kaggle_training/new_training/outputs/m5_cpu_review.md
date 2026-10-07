# M5 CPU experiment review

Completed the predefined M5-subset experiment in approximately 12.4 minutes on CPU (4 threads), with 250 general trees and 80 adaptation trees. Seed 42 sampled 60 catalog products; earlier availability filtering retained 53 products across 10 stores, totaling 806,004 daily records. Target stores: CA_1, TX_1, WI_1. All results are retained.

Training ends May 2015, validation uses June-November 2015 and the configured final-test period is December 2015-May 22, 2016. Final evaluation uses five complete non-overlapping 30-day windows beginning Dec 1, Dec 31, Jan 30, Feb 29 and Mar 30 (last window ends Apr 28). The unused tail is not scored. General training excludes the target store. Neither model is retrained on validation or final test.

## Final daily forecasting errors

| Store | Horizon | General WAPE | Personalized WAPE | Moving-average WAPE |
|---|---:|---:|---:|---:|
| CA_1 | 7 | 75.39% | 76.34% | 73.74% |
| CA_1 | 14 | 78.56% | 79.37% | 77.56% |
| CA_1 | 30 | 83.84% | 84.98% | 82.37% |
| TX_1 | 7 | 94.93% | 94.20% | 89.46% |
| TX_1 | 14 | 93.17% | 92.52% | 88.37% |
| TX_1 | 30 | 98.63% | 98.28% | 94.57% |
| WI_1 | 7 | 90.23% | 89.89% | 84.45% |
| WI_1 | 14 | 93.29% | 92.66% | 87.79% |
| WI_1 | 30 | 99.13% | 98.43% | 93.96% |

WAPE is total absolute error divided by total actual sales, not classification accuracy. Zero-sales days are included. The moving average has lower final-test WAPE than both learned models in every store/horizon. Validation selected general XGBoost for CA_1 and moving average for TX_1/WI_1. We do not switch California's selected method after inspecting final-test scores.

## Opinion and limits

The earlier 9-12% errors do not transfer to this harder subset. Store-specific continuation gives no practical advantage over the best baseline. Low-volume and irregular daily sales need a different approach or a more appropriate planning target before making broad accuracy claims. This is a useful negative result, not a reason to hide the dataset or cherry-pick products.

Retain the automatic validation-based choice among learned models and simple baselines. Investigate intermittent-demand methods, a direct weekly/30-day total forecast, and justified context features using training/validation data. Reserve a new untouched evaluation before presenting improvements as generalization results: do not optimize on these final scores and call them untouched again.

The supplemental 30-day-total report is descriptive only: it sums forecasts after the fact and does not alter model selection or establish a new validated method. This is a catalog-selected M5 subset, not the official full M5 benchmark, independent-business validation, cross-country validation or stockout demand prediction. Prices only determine launch metadata; events, future prices and prediction intervals are not model inputs. Stores share a retail chain and source data.

## Verification

All saved validation/final-test metrics were independently recomputed from forecast rows. Validation-only choices match manifests. Both models reload with expected tree counts. ZIP integrity passed. Hashes of all 18 original runtime artifacts remain unchanged. Experimental outputs remain separate from application models.
