"""Load a fixed reserved cohort after protocol freeze; no resampling."""
import numpy as np
import pandas as pd


def eligibility_table(catalog, first_weeks, calendar, train_end):
    week_starts = calendar.groupby("wm_yr_wk").date.min()
    audit = catalog.merge(first_weeks.rename("first_week").reset_index(), on=["store_id", "item_id"], how="left", validate="one_to_one")
    audit["launch_date"] = audit.first_week.map(week_starts)
    audit["past_availability_eligible"] = audit.launch_date.le(pd.Timestamp(train_end) - pd.Timedelta(days=180))
    all_stores = audit.groupby("item_id").past_availability_eligible.all()
    audit["eligible_product_all_stores"] = audit.item_id.map(all_stores)
    audit["reason"] = np.where(audit.eligible_product_all_stores, "eligible",
                              "insufficient_past_availability_in_at_least_one_store")
    return audit


def load_reserved(paths, selected, train_end, test_end):
    calendar_path, sales_path, prices_path = paths
    calendar = pd.read_csv(calendar_path, parse_dates=["date"])
    metadata = ["item_id", "dept_id", "cat_id", "store_id", "state_id"]
    catalog_all = pd.read_csv(sales_path, usecols=metadata)
    catalog = catalog_all.loc[catalog_all.item_id.isin(selected)].copy()
    assert catalog.item_id.nunique() == len(selected)
    assert len(catalog) == len(selected) * catalog_all.store_id.nunique()
    first = None
    for chunk in pd.read_csv(prices_path, usecols=["store_id", "item_id", "wm_yr_wk", "sell_price"], chunksize=200000):
        chunk = chunk.loc[chunk.item_id.isin(selected)]
        if chunk.sell_price.isna().any() or chunk.sell_price.le(0).any():
            raise ValueError("Invalid reserved price metadata.")
        current = chunk.groupby(["store_id", "item_id"]).wm_yr_wk.min()
        first = current if first is None else pd.concat([first, current]).groupby(level=[0, 1]).min()
    audit = eligibility_table(catalog, first, calendar, train_end)
    chosen = sorted(audit.loc[audit.eligible_product_all_stores, "item_id"].unique())
    if not chosen:
        raise ValueError("No eligible reserved products; do not replace the cohort.")
    header = pd.read_csv(sales_path, nrows=0).columns
    dates = calendar.loc[calendar.date.le(pd.Timestamp(test_end)) & calendar.d.isin(header)]
    assert dates.date.max() == pd.Timestamp(test_end)
    day_columns = dates.d.tolist()
    parts = []
    launches = audit.loc[audit.eligible_product_all_stores, ["store_id", "item_id", "launch_date"]]
    for chunk in pd.read_csv(sales_path, usecols=metadata + day_columns, dtype={d: "float32" for d in day_columns}, chunksize=2000):
        chunk = chunk.loc[chunk.item_id.isin(chosen)]
        if chunk.empty:
            continue
        long = chunk.melt(id_vars=metadata, value_vars=day_columns, var_name="d", value_name="sales")
        long["date"] = long.d.map(dates.set_index("d").date)
        long = long.merge(launches, on=["store_id", "item_id"], validate="many_to_one")
        parts.append(long.loc[long.date.ge(long.launch_date)].drop(columns=["d", "launch_date"]))
    data = pd.concat(parts, ignore_index=True)
    stores = {name: i + 1 for i, name in enumerate(sorted(catalog_all.store_id.unique()))}
    items = {name: i + 1 for i, name in enumerate(chosen)}
    data["store"] = data.store_id.map(stores)
    data["item"] = data.item_id.map(items)
    data = data.sort_values(["store", "item", "date"]).reset_index(drop=True)
    assert not data.duplicated(["store", "item", "date"]).any()
    assert not data[["date", "sales", "store", "item"]].isna().any().any()
    assert np.isfinite(data.sales).all() and data.sales.ge(0).all()
    for _, group in data.groupby(["store", "item"]):
        assert group.date.diff().dropna().eq(pd.Timedelta(days=1)).all()
    return data, audit, stores
