"""Step 2: train the two shared v2 production models with the fixed recipe.

Recipe (frozen protocol nexus-final-protocol-20261006-v1, general model):
  - data: the 53 development products in ALL ten M5 stores, sales through
    2015-05-31 only (the adapter does not read later sales-day columns);
  - targets and features: weekly_forecasting.direct_training_frame (unchanged);
  - model: store_personalization.new_model(250, Config()) parameters, seed 42.
No holdout product is read. Nothing is tuned. The models and their manifest go
to ml/models_v2/, which is the only folder the application's v2 code loads from.
"""
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import xgboost as xgb

from common import (FROZEN, HORIZONS, MODELS_V2, OUTPUT, RECIPE, TRAINING_END, m5_paths, read_json,
                    sha256, versions, write_json)
from m5_adapter import adapt_m5
from store_personalization import Config, new_model
from weekly_forecasting import direct_training_frame
from v2.features import FEATURES, origin_features


def check_against_v2(history, frame, rows=300, seed=7):
    """Training inputs must equal what the application computes at inference."""
    rng = np.random.default_rng(seed)
    sample = frame.iloc[rng.choice(len(frame), size=min(rows, len(frame)), replace=False)]
    worst = 0.0
    for _, row in sample.iterrows():
        series = history.loc[(history.store == row.store) & (history["item"] == row["item"]) & (history.date < row.date)]
        values = series.sort_values("date").sales.to_numpy(dtype=float)
        got = origin_features(values, row.date.date())
        worst = max(worst, float(np.max(np.abs(got - row[FEATURES].to_numpy(dtype=float)))))
    # pandas' rolling windows accumulate rounding over long series (~1e-7 on
    # relative inputs); anything larger would be a real mismatch.
    if worst > 1e-6:
        raise AssertionError(f"training features differ from v2 inference features (max {worst})")
    return len(sample), worst


def main():
    reservation_path = OUTPUT / "holdout_reservation.json"
    if not reservation_path.exists():
        raise FileNotFoundError("Reserve the fresh holdout first (reserve_holdout.py).")
    if (MODELS_V2 / "manifest.json").exists():
        raise FileExistsError("Production models already exist; preserve them.")
    reservation = read_json(reservation_path)
    protocol = read_json(FROZEN / "protocol.json")
    data, details = adapt_m5(*m5_paths(), items_per_category=20, train_end=TRAINING_END, test_end=TRAINING_END)
    if details["selected_items"] != protocol["development_products"]:
        raise AssertionError("Training products must be exactly the 53 development products.")
    if set(data.item_id) & set(reservation["selected_products"]):
        raise AssertionError("A holdout product reached training.")
    if data.date.max() > pd.Timestamp(TRAINING_END):
        raise AssertionError("Training data extends past the cutoff.")
    MODELS_V2.mkdir(parents=True, exist_ok=True)
    config = Config()
    models, summary = {}, {}
    for horizon in HORIZONS:
        frame = direct_training_frame(data, horizon)
        features = [c for c in frame if c not in ["scale", "target", "store", "item", "date"]]
        if features != FEATURES:
            raise AssertionError("Training features differ from the v2 feature contract.")
        checked, worst = check_against_v2(data, frame)
        model = new_model(250, config)
        params = {k: model.get_params()[k] for k in RECIPE}
        if params != RECIPE:
            raise AssertionError(f"Recipe drift: {params}")
        model.fit(frame[features].astype("float32"), frame.target.astype("float32"))
        name = f"shared_total_{horizon}.json"
        model.save_model(MODELS_V2 / name)
        models[str(horizon)] = {"file": name, "sha256": sha256(MODELS_V2 / name), "trees": 250,
                                "target": f"sum of the next {horizon} days / ((previous 28-day mean + 1) * {horizon})"}
        summary[str(horizon)] = {"training_rows": int(len(frame)), "series": int(frame.groupby(["store", "item"]).ngroups),
                                 "first_label_date": str(frame.date.min().date()), "last_label_date": str(frame.date.max().date()),
                                 "feature_rows_checked_against_v2": checked, "max_feature_difference": worst}
        print("Trained", name, summary[str(horizon)], flush=True)
    manifest = {
        "release": "nexus-v2-shared-20261008",
        "status": "candidate — pending architect review",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "xgboost_version": xgb.__version__,
        "features": FEATURES,
        "models": models,
        "training": {
            "recipe": RECIPE, "recipe_source": "frozen protocol nexus-final-protocol-20261006-v1 (general model)",
            "data": "M5, 53 development products x 10 stores, launch (first price) to 2015-05-31",
            "products": details["selected_items"], "stores": sorted(details["store_mapping"]),
            "training_end": TRAINING_END, "rows": summary,
            "holdout_excluded": reservation["reservation_id"],
            "versions": versions()},
        "serving_rule": {"rare": "tsb", "regular": "shared model", "occasional": "shared model", "dormant": "shared model",
                         "history_tiers": {"insufficient": "< 28 days", "average_28": "28-179 days", "rule": ">= 180 days"}},
        "never_loaded_by_v2": "ml/models/*.pkl (legacy country models and personal fine-tuned models)",
    }
    write_json(MODELS_V2 / "manifest.json", manifest)
    write_json(OUTPUT / "training_summary.json", {"manifest_sha256": sha256(MODELS_V2 / "manifest.json"), **summary})
    print("Saved models and manifest to", MODELS_V2)


if __name__ == "__main__":
    main()
