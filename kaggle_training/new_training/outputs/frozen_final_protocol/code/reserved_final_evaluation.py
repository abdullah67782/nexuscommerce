"""Frozen final evaluator. Run only after explicit authorization for Step 6.

This file is copied into a self-contained protocol bundle before reserved sales
are read. No fitting or method selection is allowed in the final evaluator.
"""
from pathlib import Path
import argparse
import hashlib
import json
import platform

import numpy as np
import pandas as pd
import xgboost as xgb

from analyze_sales_patterns import planning_group
from weekly_forecasting import forecast_total, score


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_bundle(bundle):
    protocol_path = bundle / "protocol.json"
    if sha256(protocol_path) != (bundle / "protocol.sha256").read_text().strip():
        raise ValueError("Frozen protocol changed.")
    protocol = json.loads(protocol_path.read_text())
    for relative, expected in protocol["artifact_hashes"].items():
        if sha256(bundle / relative) != expected:
            raise ValueError(f"Frozen artifact changed: {relative}")
    versions = {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__, "xgboost": xgb.__version__}
    if versions != protocol["versions"]:
        raise ValueError("Use the frozen package versions for reproducible evaluation.")
    for source in protocol["sources"].values():
        if sha256(source["path"]) != source["sha256"]:
            raise ValueError("Source dataset changed.")
    return protocol


def eligibility_table(catalog, launches, products, stores, cutoff):
    pairs = pd.MultiIndex.from_product([stores, products], names=["store_id", "item_id"]).to_frame(index=False)
    catalog = catalog[["store_id", "item_id"]].drop_duplicates().assign(catalog_present=True)
    result = pairs.merge(catalog, on=["store_id", "item_id"], how="left", validate="one_to_one")
    result = result.merge(launches[["store_id", "item_id", "launch_date"]], on=["store_id", "item_id"], how="left", validate="one_to_one")
    result["days_available_at_cutoff"] = (pd.Timestamp(cutoff) - result.launch_date).dt.days
    result["eligible"] = result.catalog_present.eq(True) & result.days_available_at_cutoff.ge(180)
    result["reason"] = np.select([~result.catalog_present.eq(True), result.launch_date.isna(), result.days_available_at_cutoff.lt(180)],
                                 ["missing_catalog_pair", "no_price_availability_date", "less_than_180_days_at_training_cutoff"], default="eligible")
    return result


def read_reserved(protocol):
    sources = protocol["sources"]
    calendar = pd.read_csv(sources["calendar"]["path"], parse_dates=["date"])
    calendar = calendar.loc[calendar.date <= pd.Timestamp(protocol["evaluation_end"])]
    sales_path = sources["sales"]["path"]
    metadata = ["item_id", "dept_id", "cat_id", "store_id", "state_id"]
    catalog = pd.read_csv(sales_path, usecols=metadata)
    products, stores = protocol["reserved_products"], protocol["target_stores"]
    target_catalog = catalog.loc[catalog.item_id.isin(products) & catalog.store_id.isin(stores)]
    if target_catalog.duplicated(["store_id", "item_id"]).any():
        raise ValueError("Duplicate reserved store-product metadata.")
    first_weeks = []
    for chunk in pd.read_csv(sources["prices"]["path"], usecols=["store_id", "item_id", "wm_yr_wk", "sell_price"], chunksize=200000):
        chunk = chunk.loc[chunk.item_id.isin(products) & chunk.store_id.isin(stores)]
        if (chunk.sell_price <= 0).any() or chunk.sell_price.isna().any():
            raise ValueError("Invalid reserved price availability metadata.")
        first_weeks.append(chunk.groupby(["store_id", "item_id"]).wm_yr_wk.min())
    if first_weeks:
        first = pd.concat(first_weeks).groupby(level=[0, 1]).min().rename("first_week").reset_index()
        first["launch_date"] = first.first_week.map(calendar.groupby("wm_yr_wk").date.min())
    else:
        first = pd.DataFrame(columns=["store_id", "item_id", "launch_date"])
        first["launch_date"] = pd.to_datetime(first.launch_date)
    eligibility = eligibility_table(target_catalog, first, products, stores, protocol["training_end"])
    eligible = eligibility.loc[eligibility.eligible, ["store_id", "item_id", "launch_date"]]
    if eligible.empty:
        return pd.DataFrame(), eligibility
    header = pd.read_csv(sales_path, nrows=0).columns
    calendar = calendar.loc[calendar.d.isin(header)]
    if calendar.date.max() != pd.Timestamp(protocol["evaluation_end"]):
        raise ValueError("Source sales do not reach the frozen final date.")
    day_columns = calendar.d.tolist()
    parts = []
    for chunk in pd.read_csv(sales_path, usecols=metadata + day_columns,
                             dtype={d: "float32" for d in day_columns}, chunksize=2000):
        chunk = chunk.loc[chunk.item_id.isin(products) & chunk.store_id.isin(stores)]
        chunk = chunk.merge(eligible, on=["store_id", "item_id"], validate="one_to_one")
        if chunk.empty:
            continue
        long = chunk.melt(id_vars=metadata + ["launch_date"], value_vars=day_columns, var_name="d", value_name="sales")
        long["date"] = long.d.map(calendar.set_index("d").date)
        parts.append(long.loc[long.date >= long.launch_date].drop(columns=["d", "launch_date"]))
    if not parts:
        raise ValueError("Eligible products missing sales rows.")
    data = pd.concat(parts, ignore_index=True)
    data["item"] = data.item_id.map({name: i + 1 for i, name in enumerate(sorted(products))})
    data = data.sort_values(["store_id", "item", "date"]).reset_index(drop=True)
    if data.duplicated(["store_id", "item", "date"]).any() or data.sales.isna().any() or (data.sales < 0).any() or not np.isfinite(data.sales).all():
        raise ValueError("Invalid reserved sales records; do not silently repair final data.")
    for _, g in data.groupby(["store_id", "item"]):
        if not g.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError("Missing reserved history dates.")
    return data, eligibility


def evaluate_store(target, horizon, models, features, routes, start, end):
    results, dates = [], []
    origins = pd.date_range(start, pd.Timestamp(end) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D")
    for origin in origins:
        history = target.loc[target.date < origin]
        if any(len(g) < 56 for _, g in history.groupby("item")):
            raise ValueError("Eligible reserved product lacks minimum feature history.")
        groups = {item: planning_group(g.tail(180).sales.gt(0).mean()) for item, g in history.groupby("item")}
        predicted = forecast_total(history, origin, horizon, models, features, groups)
        future = target.loc[target.date.ge(origin) & target.date.lt(origin + pd.Timedelta(days=horizon))]
        counts = future.groupby("item").size()
        if len(counts) != history.item.nunique() or not counts.eq(horizon).all():
            raise ValueError("Incomplete final forecast window; do not silently remove it.")
        predicted["actual"] = predicted.item.map(future.groupby("item").sales.sum())
        predicted["selected_method"] = predicted.pattern.map(routes)
        if predicted.selected_method.isna().any():
            raise ValueError("Unknown group in frozen routing policy.")
        routed = predicted.loc[predicted.method == predicted.selected_method].copy()
        assert len(routed) == history.item.nunique()
        routed["method"] = "cautious_group_route"
        results.append(pd.concat([predicted, routed], ignore_index=True))
        dates.append({"horizon": horizon, "origin": origin, "window_end": origin + pd.Timedelta(days=horizon - 1), "products": len(routed)})
    return pd.concat(results, ignore_index=True), dates


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-final", action="store_true")
    args = parser.parse_args()
    if not args.execute_final:
        parser.error("Final outcomes remain reserved. Step 6 requires --execute-final.")
    bundle = Path(__file__).resolve().parent.parent
    protocol = verify_bundle(bundle)
    output = bundle.parent / "reserved_final_results"
    if output.exists():
        raise FileExistsError("Final evaluation already started; preserve its evidence and do not silently rerun.")
    output.mkdir()
    (output / "started.json").write_text(json.dumps({"protocol_sha256": sha256(bundle / "protocol.json"), "no_tuning": True}, indent=2))
    data, eligibility = read_reserved(protocol)
    eligibility.to_csv(output / "eligibility_all_reserved_pairs.csv", index=False)
    if data.empty:
        raise ValueError("No eligible reserved histories. Keep all exclusions; do not resample.")
    all_predictions, all_dates, metrics = [], [], []
    for store in protocol["target_stores"]:
        target = data.loc[data.store_id == store]
        if target.empty:
            continue  # All excluded pairs remain in the eligibility report.
        for horizon in protocol["horizons"]:
            models = {}
            for method in ["direct_general", "direct_personalized"]:
                model = xgb.XGBRegressor(n_jobs=4)
                model.load_model(bundle / "models" / store / f"{method}_{horizon}.json")
                models[method] = model
            features = protocol["features"][str(horizon)]
            routes = {r["pattern"]: r["selected_method"] for r in protocol["routes"] if r["horizon"] == horizon}
            rows, dates = evaluate_store(target, horizon, models, features, routes, protocol["evaluation_start"], protocol["evaluation_end"])
            rows["store"] = store
            all_predictions.append(rows)
            all_dates.extend(dict(d, store=store) for d in dates)
            for method, group in rows.groupby("method"):
                metrics.append(dict(store=store, horizon=horizon, method=method, **score(group)))
    predictions = pd.concat(all_predictions, ignore_index=True)
    predictions.to_csv(output / "predictions.csv", index=False)
    pd.DataFrame(metrics).to_csv(output / "metrics.csv", index=False)
    group_metrics = [dict(store=s, horizon=h, pattern=p, method=m, **score(g))
                     for (s, h, p, m), g in predictions.groupby(["store", "horizon", "pattern", "method"])]
    pd.DataFrame(group_metrics).to_csv(output / "group_metrics.csv", index=False)
    pd.DataFrame(all_dates).to_csv(output / "scored_windows.csv", index=False)
    runtime = protocol["runtime_artifacts"]
    for path, expected in runtime.items():
        assert sha256(path) == expected
    verify_bundle(bundle)
    (output / "run_complete.json").write_text(json.dumps({"protocol_sha256": sha256(bundle / "protocol.json"),
        "eligible_pairs": int(eligibility.eligible.sum()), "reserved_pairs": len(eligibility), "runtime_unchanged": True,
        "limitation": "New products in the same US retail chain; fixed development-trained models, no retraining on reserved history, no cross-country claim."}, indent=2))
    print(pd.DataFrame(metrics).round(3).to_string(index=False))


if __name__ == "__main__":
    main()
