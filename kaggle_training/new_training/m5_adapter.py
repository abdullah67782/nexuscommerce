"""Bounded-memory adapter for M5's wide sales format.

Select items by seeded sampling of catalog metadata, never final-test sales.
Trim pre-launch dates using the first week with a recorded selling price.
Prices are used for availability metadata only, not as future prediction inputs.
"""
from pathlib import Path
import json

import numpy as np
import pandas as pd


def locate_m5():
    roots = [Path("/kaggle/input")]
    if "__file__" in globals():
        roots.append(Path(__file__).resolve().parents[2] / "data/m5")
    for root in roots:
        if not root.exists():
            continue
        for calendar_path in sorted(root.rglob("calendar.csv")):
            folder = calendar_path.parent
            def find(name):
                return next((folder / n for n in [name, name + ".zip"] if (folder / n).exists()), None)
            sales_path = find("sales_train_evaluation.csv") or find("sales_train_validation.csv")
            prices_path = find("sell_prices.csv")
            if sales_path and prices_path:
                return calendar_path, sales_path, prices_path
    raise FileNotFoundError("Add M5 calendar, sales_train_evaluation (or validation), and sell_prices as notebook input.")


def adapt_m5(calendar_path, sales_path, prices_path, items_per_category=20, seed=42, train_end="2015-05-31", test_end="2016-05-22"):
    calendar = pd.read_csv(calendar_path, parse_dates=["date"])
    header = pd.read_csv(sales_path, nrows=0).columns
    calendar = calendar.loc[calendar.d.isin(header) & (calendar.date <= pd.Timestamp(test_end))].copy()
    day_columns = calendar.d.tolist()
    if calendar.empty or calendar.date.max() < pd.Timestamp(test_end):
        raise ValueError("Sales history does not extend through the configured final-test end date.")
    metadata = ["item_id", "dept_id", "cat_id", "store_id", "state_id"]
    catalog = pd.read_csv(sales_path, usecols=metadata)
    item_catalog = catalog[["item_id", "cat_id"]].drop_duplicates().sort_values("item_id")
    rng = np.random.default_rng(seed)
    chosen = []
    for category, group in item_catalog.groupby("cat_id", sort=True):
        count = min(items_per_category, len(group))
        chosen.extend(rng.choice(group.item_id.to_numpy(), size=count, replace=False).tolist())
    chosen = sorted(chosen)
    selected_catalog = catalog.loc[catalog.item_id.isin(chosen)].copy()
    print("M5 catalog selection:", len(chosen), "items;", selected_catalog.store_id.nunique(), "stores", flush=True)

    # Only retain selected-item price rows; use the first price date as launch proxy.
    earliest = None
    for chunk in pd.read_csv(prices_path, usecols=["store_id", "item_id", "wm_yr_wk", "sell_price"], chunksize=200000):
        chunk = chunk.loc[chunk.item_id.isin(chosen)]
        if (chunk.sell_price <= 0).any() or chunk.sell_price.isna().any():
            raise ValueError("Invalid M5 price metadata requires investigation.")
        first = chunk.groupby(["store_id", "item_id"]).wm_yr_wk.min()
        earliest = first if earliest is None else pd.concat([earliest, first]).groupby(level=[0, 1]).min()
    if earliest is None or earliest.empty:
        raise ValueError("No matching prices found.")
    week_starts = calendar.groupby("wm_yr_wk").date.min()
    launches = earliest.rename("first_week").reset_index()
    launches["launch_date"] = launches.first_week.map(week_starts)
    # Eligibility uses earlier availability metadata, not future sales targets.
    launches = launches.loc[launches.launch_date <= pd.Timestamp(train_end) - pd.Timedelta(days=180)]
    common_items = launches.groupby("item_id").store_id.nunique()
    common_items = common_items.loc[common_items == catalog.store_id.nunique()].index
    chosen = sorted(common_items)
    if not chosen:
        raise ValueError("No sampled products have enough earlier availability across all stores.")
    launches = launches.loc[launches.item_id.isin(chosen)]

    parts = []
    dtype = {day: "float32" for day in day_columns}
    for chunk in pd.read_csv(sales_path, usecols=metadata + day_columns, dtype=dtype, chunksize=2000):
        chunk = chunk.loc[chunk.item_id.isin(chosen)]
        if chunk.empty:
            continue
        long = chunk.melt(id_vars=metadata, value_vars=day_columns, var_name="d", value_name="sales")
        long["date"] = long.d.map(calendar.set_index("d").date)
        long = long.merge(launches[["store_id", "item_id", "launch_date"]], on=["store_id", "item_id"], validate="many_to_one")
        long = long.loc[long.date >= long.launch_date].drop(columns=["d", "launch_date"])
        parts.append(long)
    data = pd.concat(parts, ignore_index=True)
    store_mapping = {name: i + 1 for i, name in enumerate(sorted(catalog.store_id.unique()))}
    item_mapping = {name: i + 1 for i, name in enumerate(chosen)}
    data["store"] = data.store_id.map(store_mapping)
    data["item"] = data.item_id.map(item_mapping)
    data = data.sort_values(["store", "item", "date"]).reset_index(drop=True)
    if data.duplicated(["store", "item", "date"]).any() or data[["date", "store", "item", "sales"]].isna().any().any():
        raise ValueError("Adapter produced duplicate or missing daily records.")
    if (data.sales < 0).any() or not np.isfinite(data.sales).all():
        raise ValueError("Invalid M5 sales.")
    for key, group in data.groupby(["store", "item"], sort=False):
        if not group.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError(f"Incomplete M5 history: {key}")
    details = {"dataset": "M5", "sampling_seed": seed, "requested_items_per_category": items_per_category,
               "selected_items": chosen, "store_mapping": store_mapping, "item_mapping": item_mapping,
               "eligibility": "Recorded selling price at least 180 days before training cutoff in every store",
               "availability_caveat": "First recorded price is a launch proxy; no stockout demand is imputed.",
               "rows": len(data), "train_end": train_end, "test_end": test_end}
    print("Eligible M5 items:", len(chosen), "daily rows:", len(data), flush=True)
    return data, details


def save_m5_metadata(details, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "m5_data_manifest.json").write_text(json.dumps(details, indent=2), encoding="utf-8")
