"""Development experiment: direct weekly totals and intermittent-sale baselines.

Training ends May 2015. Method calibration uses June-August; development check
uses September-November 2015. No previously examined final-test sales are read.
This is not a new untouched final benchmark. Runtime models are never replaced.
"""
from pathlib import Path
import json
import platform
import sys
import time

import numpy as np
import pandas as pd

from m5_adapter import adapt_m5, locate_m5
from run_additional_stores_local import Tee
from store_personalization import Config, features_for_series, new_model
from analyze_sales_patterns import planning_group

TRAIN_END = pd.Timestamp("2015-05-31")
FEATURE_EXCLUDES = ["scale", "target", "store", "item", "date"]


def weekly_features(group):
    frame = features_for_series(group)
    past = group.sort_values("date").sales.astype(float).shift(1)
    for window in [28, 56]:
        frame[f"selling_fraction_{window}"] = past.gt(0).astype(float).where(past.notna()).rolling(window).mean()
    frame["positive_quantity_relative"] = past.where(past > 0).rolling(28, min_periods=1).mean().fillna(0) / frame.scale
    # Time since previous positive sale; starts at available history length if none.
    index = pd.Series(np.arange(len(group)), index=group.sort_values("date").index)
    previous_positive = index.where(past > 0).ffill()
    frame["days_since_sale"] = (index - previous_positive + 1).fillna(index + 1)
    return frame


def direct_training_frame(history, horizon):
    if history.date.max() > TRAIN_END:
        raise ValueError("Training labels must stop at the training cutoff.")
    parts = []
    for _, group in history.groupby(["store", "item"], sort=False):
        group = group.sort_values("date")
        frame = weekly_features(group)
        # Sum sales from this row through horizon-1 days later. Trailing incomplete
        # labels stay NaN, so no post-cutoff observations enter training.
        total = group.sales.rolling(horizon, min_periods=horizon).sum().shift(-(horizon - 1))
        frame["target"] = total / (frame.scale * horizon)
        frame[["date", "store", "item"]] = group[["date", "store", "item"]]
        parts.append(frame)
    return pd.concat(parts).dropna().reset_index(drop=True)


def intermittent_rates(values, alpha=.1, beta=.1):
    """Fixed SBA-Croston and TSB rate estimates using earlier observations only.

    SBA smooths nonzero quantity and inter-sale interval. TSB separately smooths
    sale probability (updated on every day) and nonzero quantity.
    """
    values = np.asarray(values, dtype=float)
    locations = np.flatnonzero(values > 0)
    if not len(locations):
        return 0., 0.
    first = locations[0]
    size = float(values[first])
    interval = float(first + 1)
    probability = 1 / interval
    croston_size = size
    gap = 1
    for quantity in values[first + 1:]:
        probability += beta * (float(quantity > 0) - probability)
        if quantity > 0:
            croston_size += alpha * (quantity - croston_size)
            interval += alpha * (gap - interval)
            size += alpha * (quantity - size)
            gap = 1
        else:
            gap += 1
    return max(0., (1 - alpha / 2) * croston_size / interval), max(0., probability * size)


def fit_direct_candidates(frame, target_store, horizon, output):
    feature_names = [c for c in frame if c not in FEATURE_EXCLUDES]
    source, target = frame.loc[frame.store != target_store], frame.loc[frame.store == target_store]
    config = Config(target_store=target_store)
    general = new_model(250, config)
    general.fit(source[feature_names].astype("float32"), source.target.astype("float32"))
    personalized = new_model(80, config)
    personalized.fit(target[feature_names].astype("float32"), target.target.astype("float32"), xgb_model=general.get_booster())
    assert personalized.get_booster().num_boosted_rounds() == 330
    output.mkdir(parents=True, exist_ok=True)
    general.save_model(output / f"direct_general_{horizon}.json")
    personalized.save_model(output / f"direct_personalized_{horizon}.json")
    print("Trained direct", horizon, "day models; source rows", len(source), "target rows", len(target), flush=True)
    return {"direct_general": general, "direct_personalized": personalized}, feature_names


def forecast_total(history, origin, horizon, models, features, groups):
    inputs, scales, items, names, baselines = [], [], [], [], []
    for item, series in history.groupby("item", sort=True):
        series = series.sort_values("date")
        extended = pd.concat([series[["date", "sales"]], pd.DataFrame({"date": [origin], "sales": [0.]})], ignore_index=True)
        frame = weekly_features(extended).iloc[-1]
        inputs.append(frame[features].to_numpy())
        scales.append(frame.scale * horizon)
        items.append(item)
        names.append(series.item_id.iloc[0])
        values = series.sales.to_numpy()
        sba, tsb = intermittent_rates(values)
        baselines.append({"mean_7": float(values[-7:].mean()) * horizon,
                          "mean_28": float(values[-28:].mean()) * horizon,
                          "croston_sba": sba * horizon, "tsb": tsb * horizon})
    rows = []
    matrix = pd.DataFrame(inputs, columns=features).astype("float32")
    for method, model in models.items():
        totals = np.maximum(0, model.predict(matrix) * np.asarray(scales))
        for item, name, total in zip(items, names, totals):
            rows.append({"item": item, "item_id": name, "origin": origin, "horizon": horizon, "method": method,
                         "predicted": float(total), "pattern": groups[item]})
    for item, name, predictions in zip(items, names, baselines):
        for method, total in predictions.items():
            rows.append({"item": item, "item_id": name, "origin": origin, "horizon": horizon, "method": method,
                         "predicted": total, "pattern": groups[item]})
    return pd.DataFrame(rows)


def backtest_totals(data, store, horizon, models, features, groups, start, end, period):
    target = data.loc[data.store == store]
    origins = pd.date_range(start, pd.Timestamp(end) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D")
    results = []
    for origin in origins:
        history = target.loc[target.date < origin]
        predicted = forecast_total(history, origin, horizon, models, features, groups)
        future = target.loc[(target.date >= origin) & (target.date < origin + pd.Timedelta(days=horizon))]
        counts = future.groupby("item").size()
        if not counts.eq(horizon).all() or len(counts) != history.item.nunique():
            raise ValueError("Incomplete evaluation window.")
        actual = future.groupby("item").sales.sum()
        predicted["actual"] = predicted.item.map(actual)
        predicted["period"] = period
        results.append(predicted)
    return pd.concat(results, ignore_index=True)


def score(rows):
    error = rows.predicted - rows.actual
    total = rows.actual.sum()
    return {"MAE_total_units": float(error.abs().mean()), "WAPE_percent": float(100 * error.abs().sum() / total) if total else np.nan,
            "bias_percent": float(100 * error.sum() / total) if total else np.nan, "windows": rows.origin.nunique(), "rows": len(rows)}


def select_routes(calibration):
    # Stable baseline default; a candidate must improve calibration absolute error
    # by >=5% relative. Weekly per-product routing needs >=8 forecast windows.
    default_scores = {method: (g.predicted - g.actual).abs().sum() for method, g in calibration.groupby("method")}
    base = min(["mean_7", "mean_28"], key=lambda m: default_scores[m])
    store_best = min(default_scores, key=default_scores.get)
    store_method = store_best if default_scores[store_best] < default_scores[base] * .95 else base
    routes = []
    for item, group in calibration.groupby("item"):
        pattern = group.pattern.iloc[0]
        candidate_scores = {m: (g.predicted - g.actual).abs().sum() for m, g in group.groupby("method")}
        reference = candidate_scores[store_method]
        best = min(candidate_scores, key=candidate_scores.get)
        enough = group.origin.nunique() >= 8 and group.loc[group.method == store_method, "actual"].gt(0).sum() >= 4
        method = best if enough and candidate_scores[best] < reference * .95 else store_method
        routes.append({"item": item, "item_id": group.item_id.iloc[0], "pattern": pattern,
                       "selected_method": method, "store_default": store_method,
                       "selection_windows": group.origin.nunique(),
                       "selection_reason": "per_product_gain" if method != store_method else "store_fallback"})
    return pd.DataFrame(routes)


def run():
    root = Path(__file__).resolve().parent
    output = root / "outputs/weekly_development"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "run_complete.json").exists():
        raise FileExistsError("Preserve the completed experiment; do not overwrite it.")
    start_time = time.perf_counter()
    console = sys.stdout
    with (output / "run.log").open("w", encoding="utf-8") as logfile:
        sys.stdout = Tee(console, logfile)
        try:
            data, details = adapt_m5(*locate_m5(), items_per_category=20, test_end="2015-11-30")
            original = json.loads((root / "outputs/m5_cpu/m5_data_manifest.json").read_text())
            assert details["selected_items"] == original["selected_items"]
            history = data.loc[data.date <= TRAIN_END]
            frames = {h: direct_training_frame(history, h) for h in [7, 28]}
            summaries, predictions_all, routes_all = [], [], []
            for store_name in ["CA_1", "TX_1", "WI_1"]:
                store = details["store_mapping"][store_name]
                target_history = history.loc[history.store == store]
                groups = {item: planning_group(g.tail(180).sales.gt(0).mean()) for item, g in target_history.groupby("item")}
                for horizon in [7, 28]:
                    print("\nSTORE", store_name, "HORIZON", horizon, flush=True)
                    models, features = fit_direct_candidates(frames[horizon], store, horizon, output / store_name)
                    calibration = backtest_totals(data, store, horizon, models, features, groups, "2015-06-01", "2015-08-31", "calibration")
                    check = backtest_totals(data, store, horizon, models, features, groups, "2015-09-01", "2015-11-30", "development_check")
                    routes = select_routes(calibration)
                    routed = check.merge(routes[["item", "selected_method"]], on="item", validate="many_to_one")
                    routed = routed.loc[routed.method == routed.selected_method].copy()
                    routed["method"] = "selected_per_product"
                    check = pd.concat([check, routed.drop(columns="selected_method")], ignore_index=True)
                    for period, table in [("calibration", calibration), ("development_check", check)]:
                        for method, group in table.groupby("method"):
                            summaries.append({"store": store_name, "horizon": horizon, "period": period, "method": method, **score(group)})
                    routes_all.append(routes.assign(store=store_name, horizon=horizon))
                    predictions_all.append(pd.concat([calibration, check]).assign(store=store_name))
                    schema = {"features": features, "target": f"sum next {horizon} days / (past 28-day mean + 1) / {horizon}",
                              "training_end": str(TRAIN_END.date()), "runtime": "Experiment only; no app integration"}
                    (output / store_name / f"schema_{horizon}.json").write_text(json.dumps(schema, indent=2), encoding="utf-8")
                    print(pd.DataFrame(summaries).loc[lambda d: (d.store == store_name) & (d.horizon == horizon) & (d.period == "development_check")].round(3).to_string(index=False), flush=True)
            summary = pd.DataFrame(summaries)
            summary.to_csv(output / "metrics.csv", index=False)
            predictions = pd.concat(predictions_all, ignore_index=True)
            predictions.to_csv(output / "predictions.csv", index=False)
            pd.concat(routes_all).to_csv(output / "product_routes.csv", index=False)
            pattern_results = []
            for (store, horizon, method, pattern), group in predictions.loc[predictions.period == "development_check"].groupby(["store", "horizon", "method", "pattern"]):
                pattern_results.append({"store": store, "horizon": horizon, "method": method, "pattern": pattern, **score(group)})
            pd.DataFrame(pattern_results).to_csv(output / "pattern_metrics.csv", index=False)
            manifest = {"elapsed_seconds": time.perf_counter() - start_time, "python": platform.python_version(),
                        "training_end": "2015-05-31", "calibration": ["2015-06-01", "2015-08-31"],
                        "development_check": ["2015-09-01", "2015-11-30"], "horizons": [7, 28],
                        "selection_rule": "5% relative absolute-error gain; >=8 windows and >=4 positive windows for per-product override",
                        "intermittent_parameters": {"alpha": .1, "beta": .1}, "sample": details,
                        "limitations": "Development comparison only, not untouched final evaluation. Four-week calibration has only three windows so uses store-level fallback. No country transfer or interval claim."}
            (output / "run_complete.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print("\nCompleted in minutes:", round(manifest["elapsed_seconds"] / 60, 2), flush=True)
        finally:
            sys.stdout = console


if __name__ == "__main__":
    run()
