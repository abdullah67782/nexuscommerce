# Step 6: reserved-product final evaluation

The final evaluation completed on the local CPU using the unchanged frozen protocol. All reserved products were accounted for, including exclusions. No model fitting, routing changes or tuning used the final outcomes. The application still uses its existing runtime models.

## What we tested

The general models were trained through May 31, 2015 on 53 development products from stores other than each target store. The diagnostic personalized models added target-store training on those development products. Neither was trained on the 60 reserved products. Earlier reserved-product sales were used only to construct forecast inputs and past-history selling groups.

The fixed rule uses TSB for rare-selling products and the general model for regular, occasional and dormant products. The test predicts total units sold in the next 7 or 28 days, rather than individual daily values. At each origin, earlier actual sales become available; future sales cannot enter the forecast. Forecasts are direct totals, not recursively filled daily predictions.

Dates: December 1, 2015-May 16, 2016, covering 24 complete weekly windows and six complete four-week windows. The planned endpoint was May 22; May 17-22 was outside complete windows and was not scored. The two horizons cover the same 168 days, but aggregation differs, so their percentage errors are not directly interchangeable measures of daily accuracy.

## Eligibility

The 60 reserved products produce 180 possible product/store histories in the three target stores. The frozen rule requires at least 180 days since first recorded price at the training cutoff. This is an availability proxy, not proof of stock availability.

| Store | Eligible histories | Excluded histories |
|---|---:|---:|
| CA_1 | 56 | 4 |
| TX_1 | 57 | 3 |
| WI_1 | 57 | 3 |
| Total | 170 | 10 |

There are 57 distinct products among the eligible histories. Every excluded pair is retained in `eligibility_all_reserved_pairs.csv`; none was replaced. Cold-start performance is not established by this test.

## Results in easy words

The fixed rule reduced error compared with the general model in all six store/horizon comparisons. The overall gains are modest. This supports using product selling patterns to choose forecasting methods, but does not prove that more complicated routing is always better.

WAPE is total absolute forecast error divided by actual sales, multiplied by 100. Lower is better. A 35% WAPE is **not** a claim of 65% accuracy for each product.

| Store | Days ahead | General WAPE | Fixed rule WAPE | Relative reduction in error |
|---|---:|---:|---:|---:|
| California | 7 | 36.193% | 35.831% | 1.00% |
| Texas | 7 | 40.993% | 40.740% | 0.62% |
| Wisconsin | 7 | 32.325% | 32.153% | 0.53% |
| California | 28 | 28.034% | 27.396% | 2.27% |
| Texas | 28 | 31.410% | 31.311% | 0.31% |
| Wisconsin | 28 | 23.227% | 22.982% | 1.06% |

Across all stores, weekly WAPE is 35.790% for the rule versus 36.058% for general. Four-week WAPE is 26.848% versus 27.213%. These are volume-weighted totals, not averages of store percentages.

The rule is the lowest-error candidate in five of six store/horizon comparisons. California four-week forecasts are an exception: TSB alone scores 25.849% and the 28-day average scores 27.087%, both better than the rule's 27.396%. Pooled four-week TSB is also slightly better than the rule (26.747% versus 26.848%). We did not change the rule to exploit that final result.

## Rare products and personalization

TSB reduces rare-product error in all six comparisons:

| Store | Days ahead | Rare-product general WAPE | Rare-product TSB WAPE |
|---|---:|---:|---:|
| California | 7 | 93.932% | 79.293% |
| Texas | 7 | 103.228% | 97.057% |
| Wisconsin | 7 | 93.644% | 86.274% |
| California | 28 | 78.323% | 53.433% |
| Texas | 28 | 71.976% | 69.512% |
| Wisconsin | 28 | 64.196% | 54.819% |

Rare-product errors are still high. They contribute only about 2.8-2.9% of actual sales volume here, so their improvements have a small effect on the headline metric. Keep product-level and group-level results visible when judging forecast quality.

The personalized candidate is worse than general in five of six comparisons; it slightly improves California four-week forecasts. Additional store-specific training has not shown a dependable benefit in this setup. Store-aware inputs and group selection are useful, but the application should not assume that fine-tuning always improves a store's forecasts.

## Verification

All checks passed:

- Recomputed 210 store/group metric rows.
- Checked actual sales totals and past-only group labels for all 35,700 saved prediction rows.
- Independently replayed 4,760 forecast rows from first/last windows using the frozen model files.
- Verified all 5,100 routed product-window forecasts match their prescribed candidate.
- Reproduced all 180 eligibility records, including exclusions.
- Verified frozen protocol, source files and listed artifacts remain unchanged.
- Verified all 18 application runtime artifacts retain their original hashes.

`product_metrics.csv` retains every eligible product's errors, including zero-sale windows and zero-total products. When actual total sales are zero, percentage error is undefined; unit errors remain reported.

## Recommendation

Proceed toward integrating the tested feature schema, direct weekly/four-week totals and the fixed rare-product TSB rule. Keep the general model as the default and automatic fine-tuning disabled until separate evidence supports it. Integration must preserve existing application functionality and match training and inference inputs exactly. This final test does not establish commercial readiness, accurate lost demand during stockouts, calibrated uncertainty, or transfer to new countries or independent businesses.

This holdout has now been evaluated. Any tuning based on its results needs a fresh holdout for the next honest final evaluation; a tuned rerun cannot be presented as this same untouched test.
