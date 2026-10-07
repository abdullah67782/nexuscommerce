"""Step 3: descriptive group comparison of saved rolling development forecasts.

No training, method selection, reserved sales access, or runtime changes.
"""
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd

from rolling_practice import guard_reserved
from weekly_forecasting import score

GROUPS = ["regular", "occasional", "rare", "dormant"]
KEYS = ["fold", "store", "horizon", "origin", "item"]


def validate_predictions(rows):
    if rows.duplicated(KEYS + ["method"]).any():
        raise ValueError("Duplicate method predictions.")
    grouped = rows.groupby(KEYS)
    if not grouped.method.nunique().eq(6).all():
        raise ValueError("Methods must be compared on identical product windows.")
    if not grouped.actual.nunique().eq(1).all() or not grouped.pattern.nunique().eq(1).all():
        raise ValueError("Actual quantities and past-history groups must agree across methods.")
    if not rows.pattern.isin(GROUPS).all():
        raise ValueError("Unknown sales group.")
    if not np.isfinite(rows[["actual", "predicted"]]).all().all() or (rows[["actual", "predicted"]] < 0).any().any():
        raise ValueError("Nonfinite or negative quantities.")


def group_score(rows):
    result = score(rows)
    # Dynamic groups: a product can contribute to different groups at later origins.
    products = rows.groupby(["store", "item_id"])
    totals = products.actual.sum()
    errors = products.apply(lambda g: (g.predicted - g.actual).abs().sum(), include_groups=False)
    positive = totals > 0
    product_wape = 100 * errors.loc[positive] / totals.loc[positive]
    zero_windows = rows.actual.eq(0)
    return dict(result, products=len(totals), actual_units=float(rows.actual.sum()),
                absolute_error_units=float((rows.predicted - rows.actual).abs().sum()),
                zero_actual_windows=int(zero_windows.sum()), zero_total_products=int((~positive).sum()),
                median_product_WAPE_percent=float(product_wape.median()) if len(product_wape) else np.nan,
                positive_total_products=len(product_wape),
                predicted_units_on_zero_actual_windows=float(rows.loc[zero_windows, "predicted"].sum()))


def aggregate(rows, keys):
    return pd.DataFrame([dict(zip(keys, key if isinstance(key, tuple) else (key,)), **group_score(g))
                         for key, g in rows.groupby(keys, sort=True)])


def comparisons(cells):
    keys = ["fold", "store", "horizon", "pattern"]
    reference = cells.loc[cells.method == "direct_general", keys + ["absolute_error_units"]].rename(columns={"absolute_error_units": "general_error_units"})
    result = cells.merge(reference, on=keys, validate="many_to_one")
    result["gain_vs_general_percent"] = np.where(result.general_error_units > 0,
        100 * (result.general_error_units - result.absolute_error_units) / result.general_error_units, np.nan)
    result["positive_volume_cell"] = result.actual_units.gt(0)
    return result


def markdown_table(frame):
    headers = list(frame.columns)
    lines = ["| " + " | ".join(map(str, headers)) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in frame.itertuples(index=False, name=None):
        values = ["undefined" if pd.isna(v) else f"{v:.2f}" if isinstance(v, (float, np.floating)) else str(v) for v in row]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def main():
    root = Path(__file__).resolve().parent
    source = root / "outputs/rolling_practice/predictions.csv"
    output = root / "outputs/sales_group_comparison"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "run_complete.json").exists():
        raise FileExistsError("Preserve completed comparison.")
    rows = pd.read_csv(source, parse_dates=["origin"])
    validate_predictions(rows)
    reserved = pd.read_csv(root / "outputs/reserved_final_test/reserved_products.csv").item_id
    guard_reserved(rows, reserved)
    pooled = aggregate(rows, ["horizon", "pattern", "method"])
    stores = aggregate(rows, ["store", "horizon", "pattern", "method"])
    cells = aggregate(rows, ["fold", "store", "horizon", "pattern", "method"])
    compare = comparisons(cells)
    stability = []
    for (horizon, pattern, method), group in compare.groupby(["horizon", "pattern", "method"]):
        valid = group.loc[group.positive_volume_cell & group.gain_vs_general_percent.notna()]
        stability.append({"horizon": horizon, "pattern": pattern, "method": method,
                          "comparable_store_periods": len(valid),
                          "periods_better_than_general": int(valid.gain_vs_general_percent.gt(1e-8).sum()),
                          "periods_at_least_5_percent_better": int(valid.gain_vs_general_percent.ge(5).sum()),
                          "median_gain_vs_general_percent": valid.gain_vs_general_percent.median(),
                          "minimum_windows_in_cell": int(group.windows.min()),
                          "minimum_products_in_cell": int(group.products.min())})
    stability = pd.DataFrame(stability)
    for name, table in [("pooled_group_metrics", pooled), ("store_group_metrics", stores),
                        ("fold_group_metrics", cells), ("comparisons_vs_general", compare), ("method_stability", stability)]:
        table.to_csv(output / f"{name}.csv", index=False)
    coverage = pooled.loc[pooled.method == "direct_general", ["horizon", "pattern", "rows", "products", "actual_units", "zero_actual_windows", "zero_total_products"]].copy()
    coverage["sales_share_percent"] = 100 * coverage.actual_units / coverage.groupby("horizon").actual_units.transform("sum")
    coverage.to_csv(output / "group_coverage.csv", index=False)
    # Verify aggregation partitions every observation and preserves absolute errors.
    for (horizon, method), group in pooled.groupby(["horizon", "method"]):
        original = rows.loc[(rows.horizon == horizon) & (rows.method == method)]
        assert group.rows.sum() == len(original)
        assert np.isclose(group.absolute_error_units.sum(), (original.predicted - original.actual).abs().sum())
        assert np.isclose(group.actual_units.sum(), original.actual.sum())
    table = pooled.pivot(index=["horizon", "pattern"], columns="method", values="WAPE_percent").reset_index()
    print("GROUP WAPE (lower is better)\n", table.round(2).to_string(index=False))
    print("\nSTABILITY\n", stability.round(2).to_string(index=False))
    print("\nCOVERAGE\n", coverage.round(2).to_string(index=False))
    report = """# Step 3: sales-group comparison

This compares the saved Step 2 forecasts. It trains no new models, chooses no routing rules, and uses no reserved-product sales.

Groups use selling frequency in the previous 180 available days at each forecast origin: regular at least 80%, occasional 20% to below 80%, rare above 0% to below 20%, dormant 0%. These are practical descriptive thresholds. Products can move between groups as their history changes. Observed zero sales do not distinguish lack of demand from stockouts.

## Combined error by group

WAPE is absolute forecast error divided by actual sales, multiplied by 100. Lower is better; this is not an accuracy percentage. It weights products by sales volume. `median_product_WAPE_percent` in the CSV gives a complementary product-level view and explicitly excludes zero-total products from that particular statistic. Zero-total products and their forecast errors remain in the main totals. Undefined WAPE means the group had no actual sales.

""" + markdown_table(table) + "\n\n## Coverage\n\n" + markdown_table(coverage) + """

## How to judge consistency

`method_stability.csv` counts the store-period comparisons where each method beats the general model, including gains of at least 5%. This is descriptive evidence, not automatic selection or statistical significance. `store_group_metrics.csv` and `fold_group_metrics.csv` retain differences hidden by pooling. Small groups and only 2-3 four-week windows per period warrant caution.

## Limits

These are previously examined development data from 53 selected products in three stores of one US retail chain. Some groups contain very few products. Summer repeats prior calibration data. Stores, periods and horizons are not independent experiments. No claim of cross-country accuracy or performance on the reserved final products is justified. Step 4 should define cautious selection rules using this evidence; final evaluation remains separate.
"""
    (output / "review.md").write_text(report, encoding="utf-8")
    manifest = {"source_predictions_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "prediction_rows": len(rows), "reserved_overlap": 0, "methods_selected": False,
                "aggregation_checks_passed": True, "output_metric_rows": len(pooled) + len(stores) + len(cells)}
    (output / "run_complete.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
