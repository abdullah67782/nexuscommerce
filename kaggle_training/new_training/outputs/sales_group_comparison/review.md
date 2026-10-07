# Step 3: sales-group comparison

This compares the saved Step 2 forecasts. It trains no new models, chooses no routing rules, and uses no reserved-product sales.

Groups use selling frequency in the previous 180 available days at each forecast origin: regular at least 80%, occasional 20% to below 80%, rare above 0% to below 20%, dormant 0%. These are practical descriptive thresholds. Products can move between groups as their history changes. Observed zero sales do not distinguish lack of demand from stockouts.

## What we learned

- **Regular sellers:** the general model is a strong weekly candidate. Its pooled weekly WAPE is 31.18%, versus 31.93% for personalization. Four-week general and TSB scores are close (32.65% versus 32.47%), with mixed period-level outcomes; this does not justify a confident switch.
- **Occasional sellers:** the general model beats both simple averages and TSB in every weekly store-period comparison. Personalization improves six of nine comparisons at both horizons, but none reaches a 5% relative improvement over general. Its combined weekly result is actually worse because the losses outweigh small gains.
- **Rare sellers:** TSB beats general in all nine store-period comparisons at both horizons. Weekly pooled WAPE falls from 89.69% to 81.58%; four-week WAPE falls from 73.28% to 59.86%. The 28-day average is also promising: 82.29% weekly and 58.74% four-week. These errors are still large, so this is improvement evidence rather than a solved forecasting problem.
- **Dormant sellers:** only five store-product combinations contribute, with just 11 actual units in weekly windows. Very large percentage errors are driven by this tiny denominator. Zero forecasts from recent averages have fewer false-positive units than the general model, but can miss products that start selling again. There is insufficient evidence to learn a reliable dormant-product policy here.

Rare sellers contribute only about 4.5-4.9% of the actual sales volume. Their poor forecasts can therefore be hidden in overall scores. Group-aware comparison is useful even when overall model results look reasonable.

For Step 4, the evidence supports testing a cautious rule with general as the usual candidate, TSB or the 28-day average considered for rare sellers, and personalization requiring meaningful, consistent gains. This report does not implement that rule or choose methods for the application. All nine comparisons share the same development cohort, so they are not nine independent proofs.

## Combined error by group

WAPE is absolute forecast error divided by actual sales, multiplied by 100. Lower is better; this is not an accuracy percentage. It weights products by sales volume. `median_product_WAPE_percent` in the CSV gives a complementary product-level view and explicitly excludes zero-total products from that particular statistic. Zero-total products and their forecast errors remain in the main totals. Undefined WAPE means the group had no actual sales.

| horizon | pattern | croston_sba | direct_general | direct_personalized | mean_28 | mean_7 | tsb |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | dormant | 3156.40 | 297.56 | 287.52 | 100.00 | 100.00 | 100.00 |
| 7 | occasional | 54.88 | 44.62 | 45.01 | 48.06 | 52.27 | 45.63 |
| 7 | rare | 104.19 | 89.69 | 90.27 | 82.29 | 89.75 | 81.58 |
| 7 | regular | 35.80 | 31.18 | 31.93 | 35.18 | 33.57 | 32.65 |
| 28 | dormant | 1130.63 | 181.58 | 209.54 | 100.00 | 100.00 | 100.00 |
| 28 | occasional | 40.69 | 38.02 | 37.59 | 39.41 | 49.80 | 39.03 |
| 28 | rare | 72.61 | 73.28 | 76.48 | 58.74 | 80.80 | 59.86 |
| 28 | regular | 34.44 | 32.65 | 34.64 | 33.99 | 37.40 | 32.47 |

## Coverage

| horizon | pattern | rows | products | actual_units | zero_actual_windows | zero_total_products | sales_share_percent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | dormant | 58 | 5 | 11.00 | 54 | 1 | 0.02 |
| 7 | occasional | 3227 | 121 | 26134.00 | 457 | 1 | 57.78 |
| 7 | rare | 1559 | 67 | 2048.00 | 743 | 3 | 4.53 |
| 7 | regular | 403 | 21 | 17037.00 | 18 | 1 | 37.67 |
| 28 | dormant | 15 | 5 | 33.00 | 11 | 1 | 0.08 |
| 28 | occasional | 778 | 118 | 25879.00 | 44 | 0 | 59.02 |
| 28 | rare | 382 | 65 | 2135.00 | 71 | 3 | 4.87 |
| 28 | regular | 97 | 20 | 15799.00 | 1 | 1 | 36.03 |

## How to judge consistency

`method_stability.csv` counts the store-period comparisons where each method beats the general model, including gains of at least 5%. This is descriptive evidence, not automatic selection or statistical significance. `store_group_metrics.csv` and `fold_group_metrics.csv` retain differences hidden by pooling. Small groups and only 2-3 four-week windows per period warrant caution.

## Limits

These are previously examined development data from 53 selected products in three stores of one US retail chain. Some groups contain very few products. Summer repeats prior calibration data. Stores, periods and horizons are not independent experiments. No claim of cross-country accuracy or performance on the reserved final products is justified. Step 4 should define cautious selection rules using this evidence; final evaluation remains separate.
