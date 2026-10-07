"""Describe M5 product/store sales using training data only; no model fitting.

Groups are simple planning heuristics, not a learned or validated classifier:
regular >=80% positive-sale days; occasional 20-80%; rare <20%; dormant 0.
Recent 180-day patterns are kept separate from full-history summaries.
"""
from pathlib import Path
import json

import numpy as np
import pandas as pd

from m5_adapter import adapt_m5, locate_m5

TRAIN_END = "2015-05-31"


def longest_zero_streak(values):
    longest = current = 0
    for value in values:
        current = current + 1 if value == 0 else 0
        longest = max(longest, current)
    return longest


def planning_group(positive_fraction):
    if positive_fraction == 0:
        return "dormant"
    if positive_fraction < 0.20:
        return "rare"
    if positive_fraction < 0.80:
        return "occasional"
    return "regular"


def summarize_series(group):
    group = group.sort_values("date")
    if group.date.max() > pd.Timestamp(TRAIN_END):
        raise ValueError("Future validation/test observations must not enter this analysis.")
    recent = group.tail(180)
    values = recent.sales.to_numpy()
    positive = values[values > 0]
    positive_fraction = len(positive) / len(values)
    # Consecutive full seven-day blocks, aligned backwards from the cutoff.
    usable = (len(values) // 7) * 7
    weekly = values[-usable:].reshape(-1, 7).sum(axis=1) if usable else np.array([])
    last_sale = recent.loc[recent.sales > 0, "date"].max()
    return {
        "store_id": group.store_id.iloc[0], "item_id": group.item_id.iloc[0],
        "category": group.cat_id.iloc[0], "state": group.state_id.iloc[0],
        "history_days": len(group), "history_start": group.date.min().date().isoformat(),
        "history_end": group.date.max().date().isoformat(), "recent_days": len(recent),
        "recent_start": recent.date.min().date().isoformat(),
        "recent_units": float(values.sum()), "mean_daily_units": float(values.mean()),
        "positive_days": len(positive), "positive_day_percent": 100 * positive_fraction,
        "zero_day_percent": 100 * (1 - positive_fraction),
        "mean_units_on_selling_days": float(positive.mean()) if len(positive) else np.nan,
        "selling_day_quantity_cv": float(positive.std(ddof=0) / positive.mean()) if len(positive) > 1 else np.nan,
        "days_per_selling_day": len(values) / len(positive) if len(positive) else np.nan,
        "longest_zero_run_days": longest_zero_streak(values),
        "days_since_last_sale": (recent.date.max() - last_sale).days if pd.notna(last_sale) else len(recent),
        "complete_week_blocks": len(weekly),
        "zero_week_percent": float(100 * np.mean(weekly == 0)) if len(weekly) else np.nan,
        "mean_weekly_units": float(weekly.mean()) if len(weekly) else np.nan,
        "weekly_quantity_cv": float(weekly.std(ddof=0) / weekly.mean()) if len(weekly) and weekly.mean() else np.nan,
        "planning_group": planning_group(positive_fraction),
    }


def analyze(data):
    if data.date.max() > pd.Timestamp(TRAIN_END):
        raise ValueError("Analysis input extends beyond training cutoff.")
    return pd.DataFrame([summarize_series(group) for _, group in data.groupby(["store_id", "item_id"], sort=True)])


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/m5_sales_patterns"
    output.mkdir(parents=True, exist_ok=True)
    # Adapter reads only sales-day columns up to the training cutoff.
    data, details = adapt_m5(*locate_m5(), items_per_category=20, train_end=TRAIN_END, test_end=TRAIN_END)
    original = json.loads((root / "outputs/m5_cpu/m5_data_manifest.json").read_text())
    if details["selected_items"] != original["selected_items"]:
        raise AssertionError("The product sample must match the previous experiment.")
    table = analyze(data)
    table.to_csv(output / "product_store_patterns.csv", index=False)
    counts = pd.crosstab(table.store_id, table.planning_group).reindex(columns=["regular", "occasional", "rare", "dormant"], fill_value=0)
    counts.to_csv(output / "store_pattern_counts.csv")
    summary = table.groupby("planning_group").agg(
        series=("item_id", "size"), median_daily_units=("mean_daily_units", "median"),
        median_zero_day_percent=("zero_day_percent", "median"), median_zero_week_percent=("zero_week_percent", "median"),
        median_longest_zero_run=("longest_zero_run_days", "median"))
    summary.to_csv(output / "group_summary.csv")
    examples = pd.concat([group.sort_values(["zero_day_percent", "item_id"]).head(3)
                          for _, group in table.groupby("planning_group")])
    examples.to_csv(output / "examples.csv", index=False)
    metadata = {"training_cutoff": TRAIN_END, "recent_window_days": 180,
                "sales_dates_read": [str(data.date.min().date()), str(data.date.max().date())],
                "series": len(table), "items": table.item_id.nunique(), "stores": table.store_id.nunique(),
                "thresholds": {"regular": ">=80% days with recorded sales", "occasional": ">=20% and <80%",
                               "rare": ">0% and <20%", "dormant": "0%"},
                "limits": "Descriptive heuristics. Zero recorded sales may reflect stockouts; availability is not known. Weekly blocks are consecutive seven-day totals, not calendar weeks. No future sales or forecast errors determine groups."}
    (output / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print("\nStore groups:\n", counts.to_string())
    print("\nGroup summary:\n", summary.round(2).to_string())
    print("\nOverall zero days:", round(table.zero_day_percent.mean(), 2),
          "%; zero seven-day blocks:", round(table.zero_week_percent.mean(), 2), "%")
    print("Saved to", output)


if __name__ == "__main__":
    main()
