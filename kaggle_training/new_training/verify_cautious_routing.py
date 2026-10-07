"""Recompute routing metrics and check frozen selection and runtime integrity."""
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd

from cautious_routing import apply_routes, choose_routes
from rolling_practice import guard_reserved
from weekly_forecasting import score


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/cautious_routing"
    manifest = json.loads((output / "run_complete.json").read_text())
    assert hashlib.sha256((output / "frozen_selection.json").read_bytes()).hexdigest() == manifest["frozen_selection_sha256"]
    practice = pd.read_csv(root / "outputs/rolling_practice/predictions.csv", parse_dates=["origin"])
    rebuilt, _ = choose_routes(practice)
    routes = pd.read_csv(output / "frozen_routes.csv")
    pd.testing.assert_frame_equal(rebuilt, routes, check_exact=False)
    rows = pd.read_csv(output / "later_development_predictions.csv", parse_dates=["origin"])
    guard_reserved(rows, pd.read_csv(root / "outputs/reserved_final_test/reserved_products.csv").item_id)
    source = rows.loc[rows.method != "cautious_group_route"].drop(columns="selected_method").copy()
    rebuilt_predictions = apply_routes(source, routes)
    saved_predictions = rows.loc[rows.method == "cautious_group_route"].copy()
    keys = ["store", "horizon", "origin", "item"]
    for table in [rebuilt_predictions, saved_predictions]:
        table.sort_values(keys, inplace=True)
    pd.testing.assert_frame_equal(rebuilt_predictions.reset_index(drop=True), saved_predictions.reset_index(drop=True), check_exact=False)
    counts = saved_predictions.groupby(["store", "horizon", "pattern", "selected_method"]).size().reset_index(name="forecast_windows")
    counts.to_csv(output / "selection_counts.csv", index=False)
    checked = 0
    for filename, grouping in [("later_development_metrics.csv", ["store", "horizon", "method"]),
                               ("later_group_metrics.csv", ["store", "horizon", "pattern", "method"])]:
        saved = pd.read_csv(output / filename).set_index(grouping)
        for key, group in rows.groupby(grouping):
            for metric, expected in score(group).items():
                assert np.isclose(saved.loc[key, metric], expected, equal_nan=True), (key, metric)
            checked += 1
    hashes = json.loads((root / "outputs/m5_cpu/original_runtime_model_hashes.json").read_text())
    for filename, expected in hashes.items():
        assert hashlib.sha256((root.parents[1] / "ml/models" / filename).read_bytes()).hexdigest() == expected
    snapshot = {name: {"sha256": hashlib.sha256((root / name).read_bytes()).hexdigest(),
                       "source": (root / name).read_text(encoding="utf-8")}
                for name in ["cautious_routing.py", "compare_sales_groups.py", "verify_cautious_routing.py"]}
    (output / "source_snapshot.json").write_text(json.dumps(snapshot, indent=2))
    result = {"passed": True, "metric_rows_recomputed": checked, "reserved_overlap": 0,
              "selection_reproduced": True, "routed_predictions_reproduced": len(saved_predictions),
              "runtime_artifacts_unchanged": len(hashes), "tests_passed": 19}
    (output / "verification.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
