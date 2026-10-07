"""Freeze then evaluate reserved products once. Never tune on final errors."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import platform
import sys
import time

import numpy as np
import pandas as pd
import xgboost as xgb

from cautious_routing import apply_routes
from compare_sales_groups import aggregate, validate_predictions
from m5_adapter import locate_m5
from reserved_m5_adapter import load_reserved
from rolling_practice import rolling_predictions
from run_additional_stores_local import Tee
from store_personalization import Config, new_model
from weekly_forecasting import direct_training_frame, score


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def freeze(root, output, reservation, paths):
    names = ["final_reserved_evaluation.py", "reserved_m5_adapter.py", "weekly_forecasting.py",
             "store_personalization.py", "rolling_practice.py", "analyze_sales_patterns.py",
             "cautious_routing.py", "compare_sales_groups.py"]
    source = {name: {"sha256": digest(root / name), "source": (root / name).read_text(encoding="utf-8")} for name in names}
    selection_path = root / "outputs/cautious_routing/frozen_selection.json"
    selection = json.loads(selection_path.read_text())
    models = {}
    for store in reservation["primary_target_stores"]:
        for h in reservation["planned_horizons"]:
            folder = root / "outputs/weekly_development" / store
            model, schema = folder / f"direct_general_{h}.json", folder / f"schema_{h}.json"
            models[f"{store}_{h}"] = {"path": str(model), "sha256": digest(model), "schema": json.loads(schema.read_text()), "schema_sha256": digest(schema)}
            assert models[f"{store}_{h}"]["schema"]["training_end"] == reservation["planned_training_end"]
    inputs = {str(path): digest(path) for path in paths}
    assert inputs[str(paths[1])] == reservation["source_sha256"]
    config = Config(train_end=reservation["planned_training_end"])
    settings = new_model(80, config).get_params()
    protocol = {"frozen_at_utc": datetime.now(timezone.utc).isoformat(), "reservation": reservation,
                "sources": source, "inputs": inputs, "general_models": models,
                "selection_sha256": digest(selection_path), "routes": selection["routes"],
                "personalization": {"settings": settings, "training": "Only eligible reserved products in the target store through the training cutoff; append 80 trees to frozen 250-tree general model. Candidate comparison only; never selected from final errors."},
                "eligibility": "First recorded price at least 180 days before cutoff in every one of ten stores. Report exclusions, do not replace them.",
                "forecasting": "Fixed models; history and groups update from earlier observations at each origin. Nonoverlapping complete windows for each horizon. No current or future actual inputs.",
                "group_policy": "Past 180 days; regular >=80%, occasional >=20% and <80%, rare >0% and <20%, dormant 0%. Rare uses TSB; other groups general.",
                "metrics": ["WAPE_percent", "MAE_total_units", "bias_percent", "group_metrics", "per_product_metrics"],
                "limitations": "New-product general-model transfer within the same US retail chain. Personalized candidate sees pre-cutoff reserved history. Not new-country or independent-business evidence; predicts observed sales, not unmet stockout demand."}
    path = output / "frozen_protocol.json"
    if path.exists():
        raise FileExistsError("Final protocol already frozen. Do not silently restart or overwrite final evaluation.")
    path.write_text(json.dumps(protocol, indent=2), encoding="utf-8")
    return protocol, digest(path)


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/final_reserved_evaluation"
    output.mkdir(parents=True, exist_ok=True)
    reservation = json.loads((root / "outputs/reserved_final_test/reservation.json").read_text())
    paths = locate_m5()
    protocol, frozen_hash = freeze(root, output, reservation, paths)
    print("Protocol frozen before reading reserved sales:", frozen_hash, flush=True)
    started = time.perf_counter()
    console = sys.stdout
    with (output / "run.log").open("w", encoding="utf-8") as logfile:
        sys.stdout = Tee(console, logfile)
        try:
            data, audit, stores = load_reserved(paths, reservation["selected_products"], reservation["planned_training_end"], reservation["planned_evaluation_end"])
            audit.to_csv(output / "eligibility_all_600_histories.csv", index=False)
            assert set(data.item_id.unique()).issubset(set(reservation["selected_products"]))
            assert not set(data.item_id.unique()) & set(reservation["excluded_prior_candidates"])
            print("Reserved products:", len(reservation["selected_products"]), "eligible:", data.item.nunique(), "excluded:", len(reservation["selected_products"]) - data.item.nunique(), flush=True)
            cutoff = pd.Timestamp(reservation["planned_training_end"])
            training = data.loc[data.date <= cutoff]
            routes = pd.DataFrame(protocol["routes"])
            all_rows, all_exclusions, windows = [], [], []
            for horizon in reservation["planned_horizons"]:
                frame = direct_training_frame(training, horizon)
                assert (frame.date + pd.Timedelta(days=horizon - 1)).max() <= cutoff
                for store_name in reservation["primary_target_stores"]:
                    print("\nFinal store", store_name, "horizon", horizon, flush=True)
                    spec = protocol["general_models"][f"{store_name}_{horizon}"]
                    assert digest(spec["path"]) == spec["sha256"]
                    general = xgb.XGBRegressor()
                    general.load_model(spec["path"])
                    features = spec["schema"]["features"]
                    assert general.get_booster().num_boosted_rounds() == 250
                    assert general.get_booster().feature_names == features
                    target = frame.loc[frame.store == stores[store_name]]
                    personalized = new_model(80, Config(target_store=stores[store_name]))
                    personalized.fit(target[features].astype("float32"), target.target.astype("float32"), xgb_model=general.get_booster())
                    assert personalized.get_booster().num_boosted_rounds() == 330
                    model_dir = output / store_name
                    model_dir.mkdir(exist_ok=True)
                    personalized.save_model(model_dir / f"personalized_candidate_{horizon}.json")
                    models = {"direct_general": general, "direct_personalized": personalized}
                    rows, skipped = rolling_predictions(data, stores[store_name], horizon, models, features,
                                                        reservation["planned_evaluation_start"], reservation["planned_evaluation_end"])
                    rows = rows.assign(store=store_name, fold="reserved_final")
                    validate_predictions(rows)
                    selected = apply_routes(rows, routes)
                    combined = pd.concat([rows, selected], ignore_index=True)
                    all_rows.append(combined)
                    all_exclusions.extend(dict(r, store=store_name, horizon=horizon) for r in skipped)
                    windows.append({"store": store_name, "horizon": horizon, "windows": rows.origin.nunique(),
                                    "first_origin": str(rows.origin.min().date()), "last_origin": str(rows.origin.max().date()),
                                    "last_scored_day": str((rows.origin.max() + pd.Timedelta(days=horizon - 1)).date()),
                                    "unscored_tail_days": (pd.Timestamp(reservation["planned_evaluation_end"]) - rows.origin.max() - pd.Timedelta(days=horizon - 1)).days})
                    print(pd.DataFrame([dict(method=m, **score(g)) for m, g in combined.groupby("method")]).round(3).to_string(index=False), flush=True)
            predictions = pd.concat(all_rows, ignore_index=True)
            predictions.to_csv(output / "predictions.csv", index=False)
            metrics = pd.DataFrame([dict(store=s, horizon=h, method=m, **score(g)) for (s, h, m), g in predictions.groupby(["store", "horizon", "method"])])
            metrics.to_csv(output / "metrics.csv", index=False)
            aggregate(predictions, ["horizon", "pattern", "method"]).to_csv(output / "group_metrics.csv", index=False)
            aggregate(predictions, ["store", "horizon", "pattern", "method"]).to_csv(output / "store_group_metrics.csv", index=False)
            aggregate(predictions, ["store", "item_id", "horizon", "method"]).to_csv(output / "per_product_metrics.csv", index=False)
            pd.DataFrame(windows).to_csv(output / "scored_dates.csv", index=False)
            pd.DataFrame(all_exclusions, columns=["item", "item_id", "origin", "reason", "history_days", "store", "horizon"]).to_csv(output / "history_exclusions.csv", index=False)
            assert digest(output / "frozen_protocol.json") == frozen_hash
            for name, spec in protocol["sources"].items():
                assert digest(root / name) == spec["sha256"]
            hashes = json.loads((root / "outputs/m5_cpu/original_runtime_model_hashes.json").read_text())
            for name, expected in hashes.items():
                assert digest(root.parents[1] / "ml/models" / name) == expected
            complete = {"elapsed_seconds": time.perf_counter() - started, "frozen_protocol_sha256": frozen_hash,
                        "reserved_products": len(reservation["selected_products"]), "eligible_products": data.item.nunique(),
                        "excluded_products": len(reservation["selected_products"]) - data.item.nunique(),
                        "runtime_artifacts_unchanged": len(hashes), "routes_changed_after_results": False,
                        "versions": {"python": platform.python_version(), "xgboost": xgb.__version__, "pandas": pd.__version__, "numpy": np.__version__}}
            (output / "run_complete.json").write_text(json.dumps(complete, indent=2))
            print("Completed minutes:", round(complete["elapsed_seconds"] / 60, 2), flush=True)
        finally:
            sys.stdout = console


if __name__ == "__main__":
    main()
