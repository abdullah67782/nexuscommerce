"""Audit the completed final evaluation without selecting or tuning methods."""
from pathlib import Path
import json
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "outputs/frozen_final_protocol"
sys.path.insert(0, str(BUNDLE / "code"))
from reserved_final_evaluation import evaluate_store, read_reserved, sha256, verify_bundle
from analyze_sales_patterns import planning_group
from weekly_forecasting import score


def main():
    output = ROOT / "outputs/reserved_final_results"
    completed = json.loads((output / "run_complete.json").read_text())
    protocol = verify_bundle(BUNDLE)
    assert completed["protocol_sha256"] == sha256(BUNDLE / "protocol.json")
    data, eligibility = read_reserved(protocol)
    saved_eligibility = pd.read_csv(output / "eligibility_all_reserved_pairs.csv", parse_dates=["launch_date"])
    pd.testing.assert_frame_equal(eligibility.reset_index(drop=True), saved_eligibility, check_dtype=False)
    assert len(eligibility) == 180
    rows = pd.read_csv(output / "predictions.csv", parse_dates=["origin"])
    keys = ["store", "horizon", "origin", "item_id"]
    assert not rows.duplicated(keys + ["method"]).any()
    assert rows.groupby(keys).method.nunique().eq(7).all()
    assert rows.predicted.ge(0).all() and np.isfinite(rows.predicted).all()
    assert set(rows.item_id).issubset(protocol["reserved_products"])
    assert not set(rows.item_id) & set(protocol["development_products"])
    actual_checks = pattern_checks = replay_checks = 0
    for store in protocol["target_stores"]:
        target = data.loc[data.store_id == store]
        eligible_items = set(eligibility.loc[eligibility.store_id.eq(store) & eligibility.eligible, "item_id"])
        if not eligible_items:
            assert not rows.store.eq(store).any()
            continue
        for horizon in protocol["horizons"]:
            group = rows.loc[rows.store.eq(store) & rows.horizon.eq(horizon)]
            assert set(group.item_id) == eligible_items
            expected_origins = pd.date_range(protocol["evaluation_start"], pd.Timestamp(protocol["evaluation_end"]) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D")
            assert set(group.origin) == set(expected_origins)
            for origin, forecasts in group.groupby("origin"):
                assert set(forecasts.item_id) == eligible_items
                actual = target.loc[target.date.ge(origin) & target.date.lt(origin + pd.Timedelta(days=horizon))].groupby("item_id").sales.sum()
                np.testing.assert_allclose(forecasts.actual, forecasts.item_id.map(actual), rtol=0, atol=1e-8)
                actual_checks += len(forecasts)
                history = target.loc[target.date < origin]
                patterns = {name: planning_group(g.tail(180).sales.gt(0).mean()) for name, g in history.groupby("item_id")}
                assert forecasts.pattern.eq(forecasts.item_id.map(patterns)).all()
                pattern_checks += len(forecasts)
            # Replay first and last windows from actual earlier histories using
            # the frozen models, independent of saved prediction rows.
            models = {}
            for method in ["direct_general", "direct_personalized"]:
                model = xgb.XGBRegressor(n_jobs=4)
                model.load_model(BUNDLE / "models" / store / f"{method}_{horizon}.json")
                models[method] = model
            routes = {r["pattern"]: r["selected_method"] for r in protocol["routes"] if r["horizon"] == horizon}
            for origin in [expected_origins[0], expected_origins[-1]]:
                replay, _ = evaluate_store(target, horizon, models, protocol["features"][str(horizon)], routes,
                                            origin, origin + pd.Timedelta(days=horizon - 1))
                saved = group.loc[group.origin.eq(origin)].set_index(["item_id", "method"]).sort_index()
                replay = replay.set_index(["item_id", "method"]).sort_index()
                assert saved.index.equals(replay.index)
                np.testing.assert_allclose(saved.predicted, replay.predicted, rtol=1e-7, atol=1e-7)
                assert saved.selected_method.equals(replay.selected_method)
                replay_checks += len(replay)
    chosen = rows.loc[rows.method == "cautious_group_route"]
    reference = rows.loc[rows.method != "cautious_group_route"]
    matching = chosen.merge(reference, left_on=keys + ["selected_method"], right_on=keys + ["method"], suffixes=("_route", "_candidate"), validate="one_to_one")
    assert len(matching) == len(chosen)
    np.testing.assert_allclose(matching.predicted_route, matching.predicted_candidate, rtol=0, atol=1e-8)
    checked = 0
    for filename, grouping in [("metrics.csv", ["store", "horizon", "method"]),
                               ("group_metrics.csv", ["store", "horizon", "pattern", "method"])]:
        saved = pd.read_csv(output / filename).set_index(grouping)
        for key, group in rows.groupby(grouping):
            for metric, value in score(group).items():
                assert np.isclose(saved.loc[key, metric], value, equal_nan=True), (key, metric)
            checked += 1
    product_metrics = []
    for (store, horizon, item, method), group in rows.groupby(["store", "horizon", "item_id", "method"]):
        product_metrics.append(dict(store=store, horizon=horizon, item_id=item, method=method,
                                    actual_units=group.actual.sum(), absolute_error_units=(group.predicted - group.actual).abs().sum(),
                                    zero_actual_windows=int(group.actual.eq(0).sum()), **score(group)))
    pd.DataFrame(product_metrics).to_csv(output / "product_metrics.csv", index=False)
    summary = pd.read_csv(output / "metrics.csv").pivot(index=["store", "horizon"], columns="method", values="WAPE_percent")
    summary["route_gain_vs_general_percent"] = 100 * (summary.direct_general - summary.cautious_group_route) / summary.direct_general
    summary.to_csv(output / "comparison.csv")
    for path, expected in protocol["runtime_artifacts"].items():
        assert sha256(path) == expected
    audit = {"passed": True, "metric_rows_recomputed": checked, "actual_quantities_checked": actual_checks,
             "past_only_pattern_labels_checked": pattern_checks, "forecast_rows_replayed": replay_checks,
             "routed_rows_checked": len(chosen), "reserved_pairs": len(eligibility),
             "eligible_pairs": int(eligibility.eligible.sum()), "runtime_artifacts_unchanged": len(protocol["runtime_artifacts"]),
             "protocol_unchanged": True, "no_methods_tuned_or_selected_from_final_results": True}
    (output / "verification.json").write_text(json.dumps(audit, indent=2))
    print(json.dumps(audit, indent=2))
    print("\nCOMPARISON\n", summary.round(3).to_string())
    print("\nELIGIBILITY\n", eligibility.groupby(["store_id", "eligible", "reason"]).size().to_string())


if __name__ == "__main__":
    main()
