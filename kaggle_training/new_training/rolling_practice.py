"""Earlier rolling development checks. No method selection or runtime changes."""
from pathlib import Path
import hashlib
import json
import sys
import time

import pandas as pd

from analyze_sales_patterns import planning_group
from m5_adapter import adapt_m5, locate_m5
from run_additional_stores_local import Tee
from weekly_forecasting import direct_training_frame, fit_direct_candidates, forecast_total, score

FOLDS = [
    ("winter", "2014-12-31", "2015-01-01", "2015-03-31"),
    ("spring", "2015-03-31", "2015-04-01", "2015-05-31"),
    ("summer", "2015-05-31", "2015-06-01", "2015-08-31"),
]


def guard_reserved(data, reserved):
    overlap = set(data.item_id.unique()) & set(reserved)
    if overlap:
        raise ValueError(f"Reserved products entered development: {sorted(overlap)}")


def past_groups(history):
    return {item: planning_group(g.sort_values("date").tail(180).sales.gt(0).mean())
            for item, g in history.groupby("item")}


def rolling_predictions(data, store, horizon, models, features, start, end):
    target = data.loc[data.store == store]
    results, exclusions = [], []
    origins = pd.date_range(start, pd.Timestamp(end) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D")
    for origin in origins:
        history = target.loc[target.date < origin]
        eligible = []
        for item, g in history.groupby("item"):
            dates = g.date.sort_values()
            ready = len(g) >= 56 and dates.iloc[-1] == origin - pd.Timedelta(days=1)
            ready = ready and dates.diff().dropna().eq(pd.Timedelta(days=1)).all()
            if ready:
                eligible.append(item)
            else:
                exclusions.append({"item": item, "item_id": g.item_id.iloc[0], "origin": origin,
                                   "reason": "fewer_than_56_days_or_incomplete_past", "history_days": len(g)})
        history = history.loc[history.item.isin(eligible)]
        predicted = forecast_total(history, origin, horizon, models, features, past_groups(history))
        future = target.loc[target.item.isin(eligible) & target.date.ge(origin)
                            & target.date.lt(origin + pd.Timedelta(days=horizon))]
        counts = future.groupby("item").size()
        if len(counts) != len(eligible) or not counts.eq(horizon).all():
            raise ValueError("Incomplete future window; do not silently drop products based on outcomes.")
        predicted["actual"] = predicted.item.map(future.groupby("item").sales.sum())
        results.append(predicted)
    return pd.concat(results, ignore_index=True), exclusions


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/rolling_practice"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "run_complete.json").exists():
        raise FileExistsError("Preserve completed rolling experiment.")
    started = time.perf_counter()
    console = sys.stdout
    with (output / "run.log").open("w", encoding="utf-8") as logfile:
        sys.stdout = Tee(console, logfile)
        try:
            reserved = pd.read_csv(root / "outputs/reserved_final_test/reserved_products.csv").item_id.tolist()
            data, details = adapt_m5(*locate_m5(), items_per_category=20, test_end="2015-08-31")
            guard_reserved(data, reserved)
            original = json.loads((root / "outputs/m5_cpu/m5_data_manifest.json").read_text())
            assert details["selected_items"] == original["selected_items"]
            predictions, exclusions, summaries = [], [], []
            for fold, cutoff, start, end in FOLDS:
                history = data.loc[data.date <= pd.Timestamp(cutoff)]
                for horizon in [7, 28]:
                    frame = direct_training_frame(history, horizon)
                    assert (frame.date + pd.Timedelta(days=horizon - 1)).max() <= pd.Timestamp(cutoff)
                    for store_name in ["CA_1", "TX_1", "WI_1"]:
                        print(f"\n{fold}: train through {cutoff}; {store_name}; {horizon} days", flush=True)
                        store = details["store_mapping"][store_name]
                        model_dir = output / fold / store_name
                        models, features = fit_direct_candidates(frame, store, horizon, model_dir)
                        rows, skipped = rolling_predictions(data, store, horizon, models, features, start, end)
                        rows = rows.assign(fold=fold, training_end=cutoff, store=store_name)
                        predictions.append(rows)
                        exclusions.extend(dict(r, fold=fold, horizon=horizon, store=store_name) for r in skipped)
                        for method, group in rows.groupby("method"):
                            summaries.append(dict(fold=fold, store=store_name, horizon=horizon, method=method, **score(group)))
                        print(pd.DataFrame(summaries).tail(6)[["method", "WAPE_percent", "windows"]].round(3).to_string(index=False), flush=True)
                        (model_dir / f"schema_{horizon}.json").write_text(json.dumps({"features": features, "training_end": cutoff}, indent=2))
            all_rows = pd.concat(predictions, ignore_index=True)
            guard_reserved(all_rows, reserved)
            assert all_rows.predicted.ge(0).all() and all_rows.predicted.notna().all()
            all_rows.to_csv(output / "predictions.csv", index=False)
            pd.DataFrame(summaries).to_csv(output / "fold_metrics.csv", index=False)
            pooled = [dict(store=s, horizon=h, method=m, **score(g))
                      for (s, h, m), g in all_rows.groupby(["store", "horizon", "method"])]
            pd.DataFrame(pooled).to_csv(output / "pooled_metrics.csv", index=False)
            pd.DataFrame(exclusions, columns=["item", "item_id", "origin", "reason", "history_days", "fold", "horizon", "store"]).to_csv(output / "history_exclusions.csv", index=False)
            hashes = json.loads((root / "outputs/m5_cpu/original_runtime_model_hashes.json").read_text())
            runtime = root.parents[1] / "ml/models"
            for filename, expected in hashes.items():
                assert hashlib.sha256((runtime / filename).read_bytes()).hexdigest() == expected, filename
            manifest = {"folds": FOLDS, "sample": details, "elapsed_seconds": time.perf_counter() - started,
                        "reserved_products_excluded": len(reserved), "runtime_artifacts_unchanged": len(hashes),
                        "methods_selected": False, "groups": "Past 180 available days, recomputed at each origin",
                        "minimum_history_days": 56, "excluded_product_windows": len(exclusions),
                        "limitations": "Development cohort previously selected; summer repeats calibration period. Not untouched final evaluation. Same US retail chain, no cross-country claim. Within each fold models stay fixed; historical inputs update. Windows do not overlap within each horizon; horizons share observations."}
            (output / "run_complete.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print("Completed minutes:", round(manifest["elapsed_seconds"] / 60, 2), flush=True)
        finally:
            sys.stdout = console


if __name__ == "__main__":
    main()
