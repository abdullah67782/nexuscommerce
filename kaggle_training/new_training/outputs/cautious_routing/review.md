# Step 4: cautious forecasting selection

Built an experimental group-level rule from the January-August rolling practice predictions. The selection was saved before loading the September-November development results. No runtime model or application code was changed, and no reserved-product outcomes were used.

## What the rule does

- Regular, occasional and dormant sellers use the general model.
- Rare sellers use TSB for weekly and four-week totals.
- No product-specific overrides or automatic personalization.
- Sales groups are updated from history before each forecast origin. Unknown or unsupported groups should use the general fallback when integrating; invalid experimental group inputs fail explicitly here.

A candidate must have evidence from all three periods and all three stores; at least ten products in every store-period group; at least two forecast origins in each cell; and at least 24 weekly or eight four-week origins per store across the periods. It must reduce pooled absolute error by at least 5%, win at least 80% of store-period comparisons, improve in every pooled period, and avoid worsening any individual cell by more than 5%. These are practical conservative gates, not significance tests.

TSB passed for rare sellers with practice error reductions of 9.04% weekly and 18.31% four-week relative to the general model. Personalization passed no group. Small dormant groups failed the evidence requirement, so they retain the fallback.

## Later development check

WAPE below is total absolute error divided by actual sales. Lower is better; it is not accuracy.

| Store | Days ahead | General WAPE | Group rule WAPE | Result |
|---|---:|---:|---:|---|
| California | 7 | 38.237% | 38.017% | Small improvement |
| Texas | 7 | 42.994% | 42.750% | Small improvement |
| Wisconsin | 7 | 35.217% | 35.188% | Very small improvement |
| California | 28 | 29.297% | 29.218% | Very small improvement |
| Texas | 28 | 31.277% | 30.184% | Improvement |
| Wisconsin | 28 | 24.170% | 24.411% | Slightly worse |

The rule improves five of six comparisons but does not dominate the general model or every alternative. Wisconsin's four-week loss must remain in the report. It should not be repaired by choosing a new method from this check. Weekly overall gains are modest because rare sellers account for a small share of sales.

## Honest interpretation and next step

This replaces unstable per-product routing with a simpler reproducible experiment. It does not prove the application is more accurate: integration has not happened. Thresholds were chosen after examining development evidence. September-November was also examined in earlier work, so this is a retrospective development check, not untouched validation. Four-week periods have only two or three origins, and all stores belong to one US retail chain.

Nineteen unit tests passed, including rejection of sparse or inconsistent evidence and confirmation that future actual quantities cannot change a frozen routing decision. The verifier reproduces the selected routes, reconstructs routed predictions, recomputes saved metrics and checks the existing runtime hashes.

The later development check planned for Step 5 has been included here. Before Step 6's reserved final evaluation, freeze the complete feature schema, model settings, routing rule, eligibility checks and evaluation dates. Preserve these routes despite the Wisconsin loss. Reserved outcomes must not choose a replacement method. No commercial, cross-country or final accuracy claim is justified yet.
