"""Recompute saved metrics and audit exported rolling-practice artifacts."""
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd
import xgboost as xgb

from rolling_practice import FOLDS, guard_reserved
from weekly_forecasting import score


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/rolling_practice"
    manifest = json.loads((output / "run_complete.json").read_text())
    rows = pd.read_csv(output / "predictions.csv", parse_dates=["origin", "training_end"])
    reserved = pd.read_csv(root / "outputs/reserved_final_test/reserved_products.csv").item_id
    guard_reserved(rows, reserved)
    assert rows.predicted.ge(0).all() and np.isfinite(rows.predicted).all()
    assert not rows.duplicated(["fold", "store", "horizon", "origin", "item", "method"]).any()
    assert rows.groupby(["fold", "store", "horizon", "origin", "item"]).method.nunique().eq(6).all()
    for fold, cutoff, start, end in FOLDS:
        group = rows.loc[rows.fold == fold]
        assert group.training_end.eq(pd.Timestamp(cutoff)).all()
        assert group.origin.gt(group.training_end).all() and group.origin.ge(pd.Timestamp(start)).all()
        assert (group.origin + pd.to_timedelta(group.horizon - 1, unit="D")).le(pd.Timestamp(end)).all()
    checked = 0
    for filename, keys in [("fold_metrics.csv", ["fold", "store", "horizon", "method"]),
                           ("pooled_metrics.csv", ["store", "horizon", "method"])]:
        saved = pd.read_csv(output / filename).set_index(keys)
        for key, group in rows.groupby(keys):
            actual = score(group)
            for metric, value in actual.items():
                assert np.isclose(saved.loc[key, metric], value, equal_nan=True), (key, metric)
            checked += 1
    models = list(output.glob("*/*/direct_*.json"))
    assert len(models) == 36
    for path in models:
        booster = xgb.Booster()
        booster.load_model(path)
        assert booster.num_boosted_rounds() == (330 if "personalized" in path.name else 250)
    runtime = root.parents[1] / "ml/models"
    hashes = json.loads((root / "outputs/m5_cpu/original_runtime_model_hashes.json").read_text())
    for filename, expected in hashes.items():
        assert hashlib.sha256((runtime / filename).read_bytes()).hexdigest() == expected
    source = {}
    for filename in ["rolling_practice.py", "weekly_forecasting.py", "m5_adapter.py", "store_personalization.py", "analyze_sales_patterns.py"]:
        source[filename] = {"sha256": hashlib.sha256((root / filename).read_bytes()).hexdigest(),
                            "text": (root / filename).read_text(encoding="utf-8")}
    (output / "source_snapshot.json").write_text(json.dumps(source, indent=2), encoding="utf-8")
    audit = {"metric_rows_recomputed": checked, "models_reloaded": len(models),
             "runtime_artifacts_unchanged": len(hashes), "reserved_overlap": 0,
             "prediction_rows": len(rows), "passed": True,
             "versions": {"xgboost": xgb.__version__, "pandas": pd.__version__, "numpy": np.__version__}}
    (output / "verification.json").write_text(json.dumps(audit, indent=2))
    print(json.dumps(audit, indent=2))
    metrics = pd.read_csv(output / "fold_metrics.csv")
    print("\nAll fold scores:\n", metrics.pivot(index=["horizon", "store", "fold"], columns="method", values="WAPE_percent").round(2).to_string())
    print("\nPooled scores:\n", pd.read_csv(output / "pooled_metrics.csv").pivot(index=["store", "horizon"], columns="method", values="WAPE_percent").round(2).to_string())


if __name__ == "__main__":
    main()
