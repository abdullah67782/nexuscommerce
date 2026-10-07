"""Step 4: group-level selection with consistency gates; retrospective check.

Development check was previously examined. It is not an untouched final test.
No runtime integration or reserved-product outcome access.
"""
from pathlib import Path
import hashlib
import json
import math

import numpy as np
import pandas as pd

from compare_sales_groups import GROUPS, aggregate, validate_predictions
from m5_adapter import adapt_m5, locate_m5
from rolling_practice import guard_reserved, past_groups
from weekly_forecasting import score

RULE = {"default_method": "direct_general", "minimum_relative_gain_percent": 5.,
        "minimum_win_fraction": .8, "maximum_cell_loss_percent": 5.,
        "minimum_products_per_cell": 10, "required_folds": 3, "required_stores": 3,
        "minimum_origins_per_cell": 2, "minimum_origins_per_store": {7: 24, 28: 8},
        "require_improvement_in_every_fold": True, "per_product_overrides": False}


def candidate_evidence(cells, horizon, pattern, method):
    subset = cells.loc[(cells.horizon == horizon) & (cells.pattern == pattern)]
    keys = ["fold", "store"]
    ref = subset.loc[subset.method == RULE["default_method"]].set_index(keys)
    trial = subset.loc[subset.method == method].set_index(keys)
    if set(ref.index) != set(trial.index) or ref.empty:
        return {"horizon": horizon, "pattern": pattern, "method": method, "eligible": False,
                "reason": "missing_comparable_cells"}
    trial = trial.loc[ref.index]
    positive = ref.actual_units.gt(0) & ref.absolute_error_units.gt(0)
    gains = 100 * (ref.absolute_error_units - trial.absolute_error_units) / ref.absolute_error_units
    pooled_gain = 100 * (ref.absolute_error_units.sum() - trial.absolute_error_units.sum()) / ref.absolute_error_units.sum() if ref.absolute_error_units.sum() else np.nan
    fold_ref = ref.groupby(level="fold").absolute_error_units.sum()
    fold_trial = trial.groupby(level="fold").absolute_error_units.sum()
    fold_gains = 100 * (fold_ref - fold_trial) / fold_ref
    coverage = (len(ref) == RULE["required_folds"] * RULE["required_stores"]
                and ref.index.get_level_values("fold").nunique() == RULE["required_folds"]
                and ref.index.get_level_values("store").nunique() == RULE["required_stores"])
    enough = (coverage and positive.all() and ref.products.min() >= RULE["minimum_products_per_cell"]
              and ref.windows.min() >= RULE["minimum_origins_per_cell"]
              and ref.groupby(level="store").windows.sum().min() >= RULE["minimum_origins_per_store"][horizon])
    consistent = (gains.gt(0).sum() >= math.ceil(len(ref) * RULE["minimum_win_fraction"])
                  and gains.min() >= -RULE["maximum_cell_loss_percent"] and fold_gains.gt(0).all())
    meaningful = pooled_gain >= RULE["minimum_relative_gain_percent"]
    eligible = bool(enough and consistent and meaningful)
    return {"horizon": horizon, "pattern": pattern, "method": method, "eligible": eligible,
            "pooled_gain_percent": pooled_gain, "pooled_error_units": trial.absolute_error_units.sum(),
            "cells": len(ref), "winning_cells": int(gains.gt(0).sum()), "worst_cell_gain_percent": gains.min(),
            "minimum_fold_gain_percent": fold_gains.min(), "minimum_products": int(ref.products.min()),
            "minimum_origins_per_store": int(ref.groupby(level="store").windows.sum().min()),
            "enough_evidence": bool(enough), "consistent": bool(consistent), "meaningful_gain": bool(meaningful),
            "reason": "passed_all_gates" if eligible else "insufficient_evidence" if not enough else "inconsistent_gain" if not consistent else "gain_below_5_percent"}


def choose_routes(practice):
    validate_predictions(practice)
    cells = aggregate(practice, ["fold", "store", "horizon", "pattern", "method"])
    evidence, routes = [], []
    for horizon in [7, 28]:
        for pattern in GROUPS:
            candidates = [candidate_evidence(cells, horizon, pattern, method)
                          for method in sorted(practice.method.unique()) if method != RULE["default_method"]]
            evidence.extend(candidates)
            passed = [r for r in candidates if r["eligible"]]
            selected = min(passed, key=lambda r: (r["pooled_error_units"], r["method"])) if passed else None
            routes.append({"horizon": horizon, "pattern": pattern,
                           "selected_method": selected["method"] if selected else RULE["default_method"],
                           "reason": "consistent_group_gain" if selected else "general_fallback",
                           "practice_gain_percent": selected["pooled_gain_percent"] if selected else 0.})
    return pd.DataFrame(routes), pd.DataFrame(evidence)


def apply_routes(predictions, routes):
    mapped = predictions.merge(routes[["horizon", "pattern", "selected_method"]], on=["horizon", "pattern"], validate="many_to_one")
    chosen = mapped.loc[mapped.method == mapped.selected_method].copy()
    keys = ["store", "horizon", "origin", "item"]
    if chosen.duplicated(keys).any() or len(chosen) != len(predictions[keys].drop_duplicates()):
        raise ValueError("Every product window must receive exactly one forecast.")
    chosen["method"] = "cautious_group_route"
    return chosen


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/cautious_routing"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "run_complete.json").exists():
        raise FileExistsError("Preserve completed routing experiment.")
    practice_path = root / "outputs/rolling_practice/predictions.csv"
    practice = pd.read_csv(practice_path, parse_dates=["origin"])
    reserved = pd.read_csv(root / "outputs/reserved_final_test/reserved_products.csv").item_id
    guard_reserved(practice, reserved)
    routes, evidence = choose_routes(practice)
    routes.to_csv(output / "frozen_routes.csv", index=False)
    evidence.to_csv(output / "candidate_evidence.csv", index=False)
    frozen = {"rules": RULE, "routes": routes.to_dict(orient="records"),
              "practice_sha256": hashlib.sha256(practice_path.read_bytes()).hexdigest(),
              "scope": "Global group routes, no per-product overrides. Experiment only."}
    frozen_path = output / "frozen_selection.json"
    frozen_path.write_text(json.dumps(frozen, indent=2))
    frozen_hash = hashlib.sha256(frozen_path.read_bytes()).hexdigest()
    print("Frozen group routes:\n", routes.round(3).to_string(index=False), flush=True)
    # Rules and selected routes are saved before loading later development errors.
    check_path = root / "outputs/weekly_development/predictions.csv"
    check = pd.read_csv(check_path, parse_dates=["origin"])
    check = check.loc[(check.period == "development_check") & (check.method != "selected_per_product")].copy()
    assert check.origin.min() > practice.origin.max()
    guard_reserved(check, reserved)
    data, details = adapt_m5(*locate_m5(), items_per_category=20, test_end="2015-11-30")
    guard_reserved(data, reserved)
    assert set(data.item_id.unique()) == set(practice.item_id.unique())
    # Earlier experiment stored groups fixed at May 31. Recompute at each origin
    # to match this rule's definition, using only observations before that origin.
    for (store_name, origin), indices in check.groupby(["store", "origin"]).groups.items():
        history = data.loc[(data.store == details["store_mapping"][store_name]) & (data.date < origin)]
        check.loc[indices, "pattern"] = check.loc[indices, "item"].map(past_groups(history))
    validate_predictions(check.assign(fold="later_check"))
    selected = apply_routes(check, routes)
    combined = pd.concat([check, selected], ignore_index=True)
    metrics = pd.DataFrame([dict(store=s, horizon=h, method=m, **score(g))
                           for (s, h, m), g in combined.groupby(["store", "horizon", "method"])])
    metrics.to_csv(output / "later_development_metrics.csv", index=False)
    aggregate(combined, ["store", "horizon", "pattern", "method"]).to_csv(output / "later_group_metrics.csv", index=False)
    combined.to_csv(output / "later_development_predictions.csv", index=False)
    assert hashlib.sha256(frozen_path.read_bytes()).hexdigest() == frozen_hash
    manifest = {"frozen_selection_sha256": frozen_hash, "later_source_sha256": hashlib.sha256(check_path.read_bytes()).hexdigest(),
                "reserved_overlap": 0, "runtime_integration": False, "selection_unchanged_after_check": True,
                "limitation": "Rules informed by previously examined practice results. September-November results were also previously examined; this is a retrospective development check, not untouched validation. No final reserved outcomes used."}
    (output / "run_complete.json").write_text(json.dumps(manifest, indent=2))
    print("\nLater development WAPE:\n", metrics.pivot(index=["store", "horizon"], columns="method", values="WAPE_percent").round(3).to_string())


if __name__ == "__main__":
    main()
