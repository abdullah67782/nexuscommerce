# M5 sales-pattern inspection (training data only)

Analyzed the same 53 products across 10 stores as the prior M5 experiment: 530 separate product/store histories. Only sales through May 31, 2015 were read. The pattern groups describe the latest 180 training days, not validation or final-test outcomes. Full earlier histories are retained in the CSV summary. No model was trained, changed or selected.

## Easy summary

| Group | Definition | Product/store histories | Share |
|---|---|---:|---:|
| Regular | Sales on at least 80% of days | 38 | 7.2% |
| Occasional | Sales on 20% to less than 80% of days | 312 | 58.9% |
| Rare | Sales on fewer than 20% of days, but at least once | 176 | 33.2% |
| No recent sales | No recorded sales in the 180-day window | 4 | 0.8% |

These are simple descriptive planning thresholds, not a trained classifier or an established guarantee that a particular method will win. A product can behave differently in different stores.

## Planned target stores

| Store | Regular | Occasional | Rare | No recent sales |
|---|---:|---:|---:|---:|
| CA_1 | 5 | 33 | 14 | 1 |
| TX_1 | 3 | 32 | 18 | 0 |
| WI_1 | 4 | 33 | 16 | 0 |

Across all series, approximately 64.36% of recent daily observations have no sales. Summing complete seven-day blocks reduces zero blocks to 27.13%. This is descriptive, not a forecast accuracy measurement. Consecutive blocks are aligned backwards from the cutoff; they are not calendar weeks.

The median rare-selling series sold on about 11.67% of days and had a longest zero-sales run of 45.5 days. The median occasional series had sales on 40% of days. These histories help explain why exact daily predictions are difficult even when a model understands average sales levels.

## Recommendation

1. Preserve daily forecasts for regular sellers and evaluate weekly totals alongside them.
2. Compare methods suited to occasional sales and simple historical-rate forecasts for rare/occasional sellers. Do not assume XGBoost will win.
3. Select methods per product/store using earlier validation observations. Require enough observations to avoid reacting to random noise.
4. Flag histories with no recent sales for investigation; do not assume the product was discontinued or demand was zero.
5. Test actual direct weekly/longer-horizon targets, rather than only summing daily forecasts after the fact. Preserve daily outputs where useful.
6. Develop changes on training/validation data and reserve a genuinely new evaluation. The previously inspected M5 final test cannot be used for tuning and still be called untouched.

A zero recorded sale can result from no purchases, unavailable stock, or reporting issues. First price availability only trims likely pre-launch history; it does not establish that the product was in stock on every later day. These findings apply to this selected M5 subset, not all e-commerce stores.

## Files and checks

- `product_store_patterns.csv`: all 530 histories with daily frequency, sales levels, quantity variation, zero streaks and seven-day totals.
- `store_pattern_counts.csv`: group counts per store.
- `group_summary.csv`: group medians.
- `examples.csv`: representative rows for inspection (not products selected for favorable forecasting results).
- `manifest.json`: cutoff, grouping rules and limitations.

Five checks passed: threshold boundaries, weekly aggregation, zero-series behavior, zero streaks and rejection of post-cutoff dates. Counts and the training cutoff were independently checked after export. Runtime models remain unchanged.
