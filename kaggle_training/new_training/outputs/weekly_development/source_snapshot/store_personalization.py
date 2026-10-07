"""Store-item forecasting experiment. Never writes to the application's ml/models.

Training: source stores through 2016; adaptation: held-out store through 2016.
Selection: Jan-Jun 2017; untouched final evaluation: Jul-Dec 2017.
All horizons use recursive forecasts, not future actual sales as input.
"""
from dataclasses import asdict, dataclass
from pathlib import Path
import argparse
import json

import numpy as np
import pandas as pd
import xgboost as xgb


@dataclass
class Config:
    target_store: int = 10
    train_end: str = "2016-12-31"
    validation_end: str = "2017-06-30"
    test_end: str = "2017-12-31"
    horizon: int = 30
    origin_stride: int = 30
    general_trees: int = 250
    adaptation_trees: int = 80
    n_jobs: int = 4
    min_relative_improvement: float = 0.02
    seed: int = 42


def locate_data():
    local = Path(__file__).resolve().parents[2] / "data/store_item_demand" if "__file__" in globals() else None
    roots = [Path("/kaggle/input")]
    if local is not None:
        roots.append(local)
    matches = []
    for root in roots:
        if root.exists():
            matches.extend(root.rglob("train.csv"))
            matches.extend(root.rglob("train.csv.zip"))
    for path in sorted(matches):
        if set(pd.read_csv(path, nrows=0).columns) == {"date", "store", "item", "sales"}:
            return path
    raise FileNotFoundError("Add Store Item Demand Forecasting Challenge to the notebook, or set DATA_PATH manually.")


def load_data(path):
    data = pd.read_csv(path, usecols=["date", "store", "item", "sales"])
    data["date"] = pd.to_datetime(data["date"], errors="raise")
    if data.isna().any().any() or not np.isfinite(data.sales).all() or (data.sales < 0).any():
        raise ValueError("Missing, non-finite or negative values require an explicit cleaning policy.")
    if data.duplicated(["store", "item", "date"]).any():
        raise ValueError("Duplicate store/item/day rows: investigate before aggregating.")
    data = data.sort_values(["store", "item", "date"]).reset_index(drop=True)
    for key, group in data.groupby(["store", "item"], sort=False):
        if not group.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError(f"Missing calendar days in series {key}; do not silently fill with zero.")
    return data


def features_for_series(group):
    """Shared training/inference features. Current-day sales never enter inputs.

    Scale is the previous 28-day mean + 1. Target is sales/scale.
    No store or item ID is an input, allowing the model to work on unseen series.
    """
    group = group.sort_values("date")
    sales = group.sales.astype(float)
    past = sales.shift(1)
    scale = past.rolling(28, min_periods=28).mean() + 1.0
    result = pd.DataFrame(index=group.index)
    dates = group.date.dt
    result["day_of_week"] = dates.dayofweek
    result["month"] = dates.month
    result["is_weekend"] = (dates.dayofweek >= 5).astype(int)
    result["dow_sin"] = np.sin(2 * np.pi * dates.dayofweek / 7)
    result["dow_cos"] = np.cos(2 * np.pi * dates.dayofweek / 7)
    result["doy_sin"] = np.sin(2 * np.pi * dates.dayofyear / 365.25)
    result["doy_cos"] = np.cos(2 * np.pi * dates.dayofyear / 365.25)
    for lag in [1, 2, 7, 14, 28]:
        result[f"lag_{lag}_relative"] = sales.shift(lag) / scale
    for window in [7, 14, 28]:
        rolling = past.rolling(window, min_periods=window)
        result[f"mean_{window}_relative"] = rolling.mean() / scale
        result[f"std_{window}_relative"] = rolling.std(ddof=0) / scale
    result["trend_7_relative"] = (sales.shift(1) - sales.shift(8)) / scale
    result["scale"] = scale
    result["target"] = sales / scale
    return result


def make_training_frame(data):
    parts = []
    for _, group in data.groupby(["store", "item"], sort=False):
        frame = features_for_series(group)
        frame[["date", "store", "item"]] = group[["date", "store", "item"]]
        parts.append(frame)
    return pd.concat(parts).dropna().reset_index(drop=True)


def new_model(trees, config):
    return xgb.XGBRegressor(
        n_estimators=trees, max_depth=5, learning_rate=0.04,
        min_child_weight=10, subsample=0.85, colsample_bytree=0.9,
        reg_lambda=5, objective="reg:squarederror", tree_method="hist",
        n_jobs=config.n_jobs, random_state=config.seed,
    )


def train_candidates(data, config):
    # Split raw dates BEFORE building any training frame.
    history = data.loc[data.date <= pd.Timestamp(config.train_end)]
    if config.target_store not in set(history.store) or history.store.nunique() < 2:
        raise ValueError("Need a target store and at least one different source store.")
    frame = make_training_frame(history)
    feature_names = [c for c in frame if c not in ["date", "store", "item", "scale", "target"]]
    source = frame.loc[frame.store != config.target_store]
    target = frame.loc[frame.store == config.target_store]
    if source.empty or target.empty:
        raise ValueError("Not enough earlier history to build training features.")
    general = new_model(config.general_trees, config)
    general.fit(source[feature_names].astype("float32"), source.target.astype("float32"))
    personalized = new_model(config.adaptation_trees, config)
    # Explicit continuation from the loaded booster; not a constructor parameter.
    personalized.fit(target[feature_names].astype("float32"), target.target.astype("float32"),
                     xgb_model=general.get_booster())
    if personalized.get_booster().num_boosted_rounds() != config.general_trees + config.adaptation_trees:
        raise AssertionError("Personalization did not continue the base model.")
    print(f"General training rows: {len(source):,}; target-store adaptation rows: {len(target):,}")
    return {"general": general, "personalized": personalized}, feature_names


def forecast_models(history, models, feature_names, horizon):
    """Forecast next dates for each item; only predictions extend its history."""
    states = {name: {item: g[["date", "sales"]].copy().reset_index(drop=True)
                     for item, g in history.groupby("item", sort=True)} for name in models}
    rows = []
    for step in range(1, horizon + 1):
        for name, model in models.items():
            inputs, scales, dates, items = [], [], [], []
            for item, group in states[name].items():
                next_date = group.date.iloc[-1] + pd.Timedelta(days=1)
                # Placeholder sales are excluded by all lag/rolling features.
                extended = pd.concat([group, pd.DataFrame({"date": [next_date], "sales": [0.]})], ignore_index=True)
                next_features = features_for_series(extended).iloc[-1]
                if next_features[feature_names + ["scale"]].isna().any():
                    raise ValueError("At least 28 complete historical days are required.")
                inputs.append(next_features[feature_names].to_numpy())
                scales.append(next_features["scale"])
                dates.append(next_date)
                items.append(item)
            predictions = np.maximum(0, model.predict(pd.DataFrame(inputs, columns=feature_names).astype("float32")) * np.asarray(scales))
            for item, date, prediction in zip(items, dates, predictions):
                rows.append({"item": item, "date": date, "step": step, "method": name, "predicted": float(prediction)})
                # Retain sufficient actual/predicted history for the 28-day features.
                states[name][item] = pd.concat([states[name][item], pd.DataFrame({"date": [date], "sales": [prediction]})], ignore_index=True).tail(60)
    return pd.DataFrame(rows)


def forecast_baselines(history, horizon):
    rows = []
    for item, group in history.groupby("item", sort=True):
        dates, values = group.date, group.sales.to_list()
        moving_mean = float(np.mean(values[-7:]))
        seasonal = values[-7:].copy()
        for step in range(1, horizon + 1):
            date = dates.iloc[-1] + pd.Timedelta(days=step)
            for name, value in [("seasonal_naive", seasonal[(step - 1) % 7]), ("moving_average", moving_mean)]:
                rows.append({"item": item, "date": date, "step": step, "method": name, "predicted": value})
    return pd.DataFrame(rows)


def backtest(data, models, feature_names, config, start, end, period):
    target = data.loc[data.store == config.target_store]
    origins = pd.date_range(start, pd.Timestamp(end) - pd.Timedelta(days=config.horizon - 1), freq=f"{config.origin_stride}D")
    if len(origins) < 2:
        raise ValueError("Need at least two complete forecast windows in each evaluation period.")
    results = []
    for origin in origins:
        print(f"{period}: forecast starting {origin.date()}", flush=True)
        # No rows on/after origin are passed to either forecast function.
        history = target.loc[target.date < origin]
        predicted = pd.concat([forecast_models(history, models, feature_names, config.horizon),
                               forecast_baselines(history, config.horizon)], ignore_index=True)
        observed = target[["item", "date", "sales"]].rename(columns={"sales": "actual"})
        scored = predicted.merge(observed, on=["item", "date"], how="left", validate="many_to_one")
        if scored.actual.isna().any():
            raise ValueError("Forecast window extends beyond available observations.")
        scored["origin"] = origin
        scored["period"] = period
        results.append(scored)
    return pd.concat(results, ignore_index=True)


def metrics_table(predictions):
    rows = []
    for horizon in [7, 14, 30]:
        subset = predictions.loc[predictions.step <= horizon]
        for method, group in subset.groupby("method"):
            error = group.predicted.to_numpy() - group.actual.to_numpy()
            total = float(group.actual.sum())
            rows.append({"horizon": horizon, "method": method, "MAE": float(np.abs(error).mean()),
                         "RMSE": float(np.sqrt(np.mean(error ** 2))),
                         "WAPE_percent": float(100 * np.abs(error).sum() / total) if total else np.nan,
                         "bias_percent": float(100 * error.sum() / total) if total else np.nan,
                         "observations": len(group), "origins": group.origin.nunique()})
    return pd.DataFrame(rows)


def select_methods(validation_metrics, config):
    selection = {}
    for horizon, group in validation_metrics.groupby("horizon"):
        scores = group.set_index("method").WAPE_percent
        if scores.isna().any():
            raise ValueError("Cannot select methods when all actual sales are zero.")
        non_personalized = scores.drop("personalized").idxmin()
        enough_gain = scores.personalized < scores[non_personalized] * (1 - config.min_relative_improvement)
        selection[int(horizon)] = "personalized" if enough_gain else non_personalized
    return selection


def run_experiment(data, output_dir, config):
    if config.horizon != 30 or config.origin_stride < 30:
        raise ValueError("Use 30-day maximum horizon and non-overlapping origins at least 30 days apart.")
    if not pd.Timestamp(config.train_end) < pd.Timestamp(config.validation_end) < pd.Timestamp(config.test_end):
        raise ValueError("Training, validation and final test must be chronological.")
    models, feature_names = train_candidates(data, config)
    validation_start = pd.Timestamp(config.train_end) + pd.Timedelta(days=1)
    validation = backtest(data, models, feature_names, config, validation_start, config.validation_end, "validation")
    validation_metrics = metrics_table(validation)
    selected = select_methods(validation_metrics, config)
    print("Methods chosen using VALIDATION ONLY:", selected)
    test_start = pd.Timestamp(config.validation_end) + pd.Timedelta(days=1)
    final_test = backtest(data, models, feature_names, config, test_start, config.test_end, "final_test")
    test_metrics = metrics_table(final_test)
    selected_results = test_metrics.loc[test_metrics.apply(lambda row: selected[row.horizon] == row.method, axis=1)]
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, model in models.items():
        model.save_model(output_dir / f"{name}.json")
    manifest = {"config": asdict(config), "features": feature_names, "selected_by_horizon": selected,
                "scale": "previous 28-day mean sales + 1", "target": "sales / scale",
                "xgboost_version": xgb.__version__, "pandas_version": pd.__version__,
                "training_countries": "Not available in this dataset; do not claim cross-country validation.",
                "scope": "One held-out store; repeat with other stores before claiming general personalization gains.",
                "runtime": "Experimental schema; requires a matching inference adapter before app integration."}
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    validation_metrics.to_csv(output_dir / "validation_metrics.csv", index=False)
    test_metrics.to_csv(output_dir / "final_test_metrics.csv", index=False)
    selected_results.to_csv(output_dir / "selected_final_test_metrics.csv", index=False)
    pd.concat([validation, final_test]).to_csv(output_dir / "forecast_predictions.csv", index=False)
    # Per-item errors prevent good total scores from hiding weak products.
    per_item = []
    for (method, item), group in final_test.groupby(["method", "item"]):
        total = group.actual.sum()
        per_item.append({"method": method, "item": item, "MAE": (group.predicted - group.actual).abs().mean(),
                         "WAPE_percent": 100 * (group.predicted - group.actual).abs().sum() / total if total else np.nan})
    pd.DataFrame(per_item).to_csv(output_dir / "per_item_final_test.csv", index=False)
    print("\nFinal test (lower error is better):\n", test_metrics.round(3).to_string(index=False))
    print("\nChosen methods on final test:\n", selected_results.round(3).to_string(index=False))
    print("Results saved to", output_dir)
    return validation_metrics, test_metrics, selected


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path)
    parser.add_argument("--output", type=Path, default=Path("training_outputs/store_personalization"))
    parser.add_argument("--smoke", action="store_true", help="Small real-data code check, not final scientific results")
    args = parser.parse_args()
    config = Config()
    data = load_data(args.data or locate_data())
    if args.smoke:
        data = data.loc[data.store.isin([1, 2, 10]) & data.item.isin([1, 2])].copy()
        config.general_trees = 8
        config.adaptation_trees = 4
        config.n_jobs = 2
    run_experiment(data, args.output, config)
