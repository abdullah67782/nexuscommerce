"""Step 5: finish development audit and freeze final evaluation without sales access."""
from pathlib import Path
import json
import platform
import shutil

import pandas as pd
import numpy as np
import xgboost as xgb

from reserved_final_evaluation import sha256, verify_bundle


def main():
    root = Path(__file__).resolve().parent
    project = root.parents[1]
    output = root / "outputs/step5_readiness"
    bundle = root / "outputs/frozen_final_protocol"
    if bundle.exists():
        raise FileExistsError("Frozen protocol already exists; preserve it.")
    reservation_root = root / "outputs/reserved_final_test"
    reservation = json.loads((reservation_root / "reservation.json").read_text())
    selection_root = root / "outputs/cautious_routing"
    selection_path = selection_root / "frozen_selection.json"
    selection = json.loads(selection_path.read_text())
    check_manifest = json.loads((selection_root / "run_complete.json").read_text())
    assert sha256(selection_path) == check_manifest["frozen_selection_sha256"]
    assert json.loads((selection_root / "verification.json").read_text())["passed"]
    dev = json.loads((root / "outputs/m5_cpu/m5_data_manifest.json").read_text())
    assert not set(reservation["selected_products"]) & set(dev["selected_items"])
    output.mkdir(parents=True, exist_ok=True)
    metrics = pd.read_csv(selection_root / "later_development_metrics.csv")
    summary = metrics.loc[metrics.method.isin(["direct_general", "cautious_group_route"])].pivot(index=["store", "horizon"], columns="method", values="WAPE_percent")
    summary["error_reduction_percentage_points"] = summary.direct_general - summary.cautious_group_route
    summary["relative_error_reduction_percent"] = 100 * summary.error_reduction_percentage_points / summary.direct_general
    summary.to_csv(output / "later_period_summary.csv")
    bundle.mkdir()
    code = bundle / "code"
    code.mkdir()
    for name in ["reserved_final_evaluation.py", "weekly_forecasting.py", "store_personalization.py", "m5_adapter.py",
                 "analyze_sales_patterns.py", "run_additional_stores_local.py", "test_final_protocol.py"]:
        shutil.copy2(root / name, code / name)
    metadata = bundle / "metadata"
    metadata.mkdir()
    for name in ["reservation.json", "reserved_products.csv", "reserved_product_store_ids.csv"]:
        shutil.copy2(reservation_root / name, metadata / name)
    shutil.copy2(selection_path, metadata / "frozen_selection.json")
    shutil.copy2(root / "outputs/m5_cpu/m5_data_manifest.json", metadata / "development_sample.json")
    features = {}
    for store in reservation["primary_target_stores"]:
        model_output = bundle / "models" / store
        model_output.mkdir(parents=True)
        for horizon in reservation["planned_horizons"]:
            schema = json.loads((root / "outputs/rolling_practice/summer" / store / f"schema_{horizon}.json").read_text())
            assert schema["training_end"] == reservation["planned_training_end"]
            if str(horizon) in features:
                assert features[str(horizon)] == schema["features"]
            features[str(horizon)] = schema["features"]
            for method, trees in [("direct_general", 250), ("direct_personalized", 330)]:
                name = f"{method}_{horizon}.json"
                source = root / "outputs/rolling_practice/summer" / store / name
                # Check the model evaluated in the later period is exactly this model.
                assert sha256(source) == sha256(root / "outputs/weekly_development" / store / name)
                booster = xgb.Booster()
                booster.load_model(source)
                assert booster.num_boosted_rounds() == trees
                assert booster.feature_names == schema["features"]
                shutil.copy2(source, model_output / name)
    source_paths = {"sales": Path(reservation["source_sales_file"]), "calendar": project / "data/m5/calendar.csv",
                    "prices": project / "data/m5/sell_prices.csv.zip"}
    sources = {name: {"path": str(path.resolve()), "sha256": sha256(path)} for name, path in source_paths.items()}
    assert sources["sales"]["sha256"] == reservation["source_sha256"]
    runtime_hashes = json.loads((root / "outputs/m5_cpu/original_runtime_model_hashes.json").read_text())
    runtime = {str((project / "ml/models" / name).resolve()): expected for name, expected in runtime_hashes.items()}
    for path, expected in runtime.items():
        assert sha256(path) == expected
    artifacts = {str(path.relative_to(bundle)).replace("\\", "/"): sha256(path)
                 for path in sorted(bundle.rglob("*")) if path.is_file()}
    protocol = {"protocol_id": "nexus-final-protocol-20261006-v1", "status": "frozen_before_reserved_sales_access",
                "training_end": reservation["planned_training_end"], "evaluation_start": reservation["planned_evaluation_start"],
                "evaluation_end": reservation["planned_evaluation_end"], "horizons": reservation["planned_horizons"],
                "target_stores": reservation["primary_target_stores"], "reserved_products": reservation["selected_products"],
                "development_products": dev["selected_items"], "sources": sources, "features": features,
                "routes": selection["routes"], "selection_rules": selection["rules"],
                "model_training": {"general": "Fixed May-2015 model, 53 development products from the other nine stores",
                                   "personalized": "Fixed diagnostic candidate: general plus 80 trees on target-store development products",
                                   "reserved_product_training": False, "retraining_during_final_test": False,
                                   "parameters": {"general_trees": 250, "adaptation_trees": 80, "max_depth": 5,
                                       "learning_rate": .04, "min_child_weight": 10, "subsample": .85,
                                       "colsample_bytree": .9, "reg_lambda": 5, "objective": "reg:squarederror",
                                       "tree_method": "hist", "n_jobs": 4, "random_state": 42}},
                "target": "Sum next horizon days / ((previous 28-day mean + 1) * horizon)",
                "inference": "Predict total directly; clip below zero; prior actual observations available at each origin; no future actuals as inputs",
                "groups": {"history_days": 180, "regular": ">=80% positive days", "occasional": "20% to <80%",
                           "rare": ">0% to <20%", "dormant": "0%", "recompute_each_origin": True},
                "intermittent_settings": {"alpha": .1, "beta": .1},
                "eligibility": "Each target-store/product pair needs >=180 calendar days since first recorded-price date at training cutoff. Report all 180 pairs; no replacement products. First price is a launch proxy.",
                "cold_start": "Excluded pairs receive no headline forecast score; report their counts and reasons. Fewer than 56 days of feature history or incomplete eligible windows fail explicitly.",
                "metrics": ["WAPE_percent", "MAE_total_units", "bias_percent", "windows", "rows"],
                "zero_sales": "Preserve zeros after availability; all-zero outcome groups have undefined WAPE, not zero error. Retain their unit errors.",
                "comparisons": ["direct_general", "direct_personalized", "mean_7", "mean_28", "croston_sba", "tsb", "cautious_group_route"],
                "selection_after_final": "None. Retain every outcome, including losses; another experiment needs a fresh holdout.",
                "runtime_artifacts": runtime, "artifact_hashes": artifacts,
                "versions": {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__, "xgboost": xgb.__version__},
                "limits": "Same-chain unseen-product test, not new-country or independent-business validation. General and diagnostic personalized models were not fitted on reserved products. Final history supplies only forecast inputs."}
    (bundle / "protocol.json").write_text(json.dumps(protocol, indent=2))
    (bundle / "protocol.sha256").write_text(sha256(bundle / "protocol.json"))
    verify_bundle(bundle)
    windows = []
    for horizon in protocol["horizons"]:
        for origin in pd.date_range(protocol["evaluation_start"], pd.Timestamp(protocol["evaluation_end"]) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D"):
            windows.append({"horizon": horizon, "origin": origin, "window_end": origin + pd.Timedelta(days=horizon - 1)})
    pd.DataFrame(windows).to_csv(output / "planned_final_windows.csv", index=False)
    readiness = {"step": 5, "later_check_reproduced": True, "improved_comparisons": int(summary.error_reduction_percentage_points.gt(0).sum()),
                 "comparisons": len(summary), "protocol_sha256": sha256(bundle / "protocol.json"),
                 "frozen_models": 12, "reserved_sales_inspected": False, "reserved_final_test_executed": False,
                 "runtime_artifacts_unchanged": len(runtime), "next": "Step 6: run frozen evaluator once on reserved products"}
    (output / "run_complete.json").write_text(json.dumps(readiness, indent=2))
    print(json.dumps(readiness, indent=2))
    print(summary.round(3).to_string())


if __name__ == "__main__":
    main()
