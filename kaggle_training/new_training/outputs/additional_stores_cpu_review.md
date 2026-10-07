# Additional-store CPU results

The full predefined experiment ran locally in approximately 8 minutes. Each held-out store uses 50 product histories. General training excludes that store; personalization uses its earlier sales. Training ends 2016, validation is Jan-Jun 2017 and final evaluation is Jul-Dec 2017. Each evaluation period has six non-overlapping 30-day starting windows. Settings remain 250 general trees, 80 adaptation trees, seed 42 and four CPU threads.

| Store | Horizon | General WAPE | Personalized WAPE | Best simple baseline WAPE |
|---|---:|---:|---:|---:|
| 1 | 7 days | 10.69% | 10.69% | 17.35% |
| 1 | 14 days | 10.54% | 10.55% | 18.20% |
| 1 | 30 days | 10.66% | 10.67% | 18.59% |
| 5 | 7 days | 11.52% | 11.51% | 17.68% |
| 5 | 14 days | 11.56% | 11.55% | 18.78% |
| 5 | 30 days | 11.73% | 11.72% | 19.72% |

WAPE is absolute error divided by total observed sales; lower is better. The best baseline in this table is descriptive (the lower final-test error of the two baselines), not a method selected using test data. Operational choices come from validation only, which chose the general model in every case.

## Opinion

The shared model is useful on this benchmark and substantially beats the simple forecasts. Store-specific continuation is not providing a meaningful gain: it slightly worsens store 1 and improves store 5 by less than 0.1% relative WAPE. This agrees with the earlier store-10 outcome. The general model already consumes each product's recent history and scale, so store-aware forecasts do not require a new model for every seller.

Keep the general model as the default candidate and keep personalization as an option that must pass validation. Test the unchanged approach on M5 next before concluding it transfers to other businesses. These outcomes do not demonstrate cross-country accuracy, benefits for every store, stockout demand estimation or calibrated prediction intervals. Store folds share data and are not independent experiments. The files remain experimental and are not integrated into the running app.

## Verification

Both stores' saved metrics were independently recomputed from forecast rows and matched. Selected methods match validation-only choices. JSON models reload with 250 and 330 trees respectively. Output ZIP passed its integrity check. No runtime model was replaced.
