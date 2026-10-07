"""Step 3: freeze the one-time evaluation BEFORE any holdout sales are read.

Records hashes of the reservation, the production models and manifest, and
every code file the evaluation runs (the application's ml/v2 code included),
plus the exact windows, comparisons and metrics. evaluate_production.py
refuses to run if anything listed here has changed.
"""
from pathlib import Path

import pandas as pd

from common import (EVALUATION_END, EVALUATION_START, EXPERIMENT, HERE, HORIZONS, MODELS_V2, OUTPUT, ROOT,
                    TRAINING_END, m5_paths, read_json, sha256, versions, write_json)

CODE = [HERE / "common.py", HERE / "evaluate_production.py",
        ROOT / "ml/v2/features.py", ROOT / "ml/v2/methods.py", ROOT / "ml/v2/forecast.py", ROOT / "ml/v2/registry.py",
        EXPERIMENT / "reserved_final_evaluation.py", EXPERIMENT / "weekly_forecasting.py"]


def planned_windows():
    rows = []
    for horizon in HORIZONS:
        for origin in pd.date_range(EVALUATION_START, pd.Timestamp(EVALUATION_END) - pd.Timedelta(days=horizon - 1), freq=f"{horizon}D"):
            rows.append({"horizon": horizon, "start": str(origin.date()), "end": str((origin + pd.Timedelta(days=horizon - 1)).date())})
    return rows


def main():
    protocol_path = OUTPUT / "evaluation_protocol.json"
    if protocol_path.exists():
        raise FileExistsError("Evaluation protocol already frozen; preserve it.")
    if (OUTPUT / "evaluation_results").exists():
        raise FileExistsError("Evaluation already started.")
    reservation = read_json(OUTPUT / "holdout_reservation.json")
    manifest = read_json(MODELS_V2 / "manifest.json")
    files = [OUTPUT / "holdout_reservation.json", MODELS_V2 / "manifest.json"] + [MODELS_V2 / m["file"] for m in manifest["models"].values()] + CODE
    calendar, sales, prices = m5_paths()
    protocol = {
        "protocol_id": "nexus-v2-production-evaluation-20261008-v1",
        "status": "frozen_before_holdout_sales_were_read",
        "models": {"release": manifest["release"], "files": {h: m["file"] for h, m in manifest["models"].items()}},
        "holdout": {"reservation_id": reservation["reservation_id"], "products": reservation["selected_products"],
                    "stores": reservation["stores"]},
        "training_end": TRAINING_END, "evaluation_start": EVALUATION_START, "evaluation_end": EVALUATION_END,
        "horizons": HORIZONS, "windows": planned_windows(),
        "eligibility": "Store/product pair needs a first recorded price >= 180 days before the training cutoff (as in the first final evaluation). Every pair is reported; excluded pairs are not replaced.",
        "history": "Each forecast uses that pair's daily sales from its first-price date to the day before the window (no gaps in M5 after launch).",
        "primary": "v2_rule — the application's own code path: ml/v2 forecast_totals with models loaded by ml/v2 registry (rare -> TSB, otherwise shared model).",
        "comparisons_reported_not_selected": ["shared_model", "tsb", "mean_28"],
        "metrics": {"WAPE_percent": "100 x sum|forecast - actual| / sum(actual)", "MAE_total_units": "mean |forecast - actual| per window",
                    "bias_percent": "100 x sum(forecast - actual) / sum(actual)"},
        "groups": "Sales-pattern group recomputed at each origin from the previous 180 days.",
        "no_tuning": "Results cannot change the models, the rule, tiers or thresholds. Any change needs another fresh holdout.",
        "sources": {"calendar": sha256(calendar), "sales": sha256(sales), "prices": sha256(prices)},
        "file_hashes": {str(Path(f).relative_to(ROOT)).replace("\\", "/"): sha256(f) for f in files},
        "versions": versions(),
    }
    write_json(protocol_path, protocol)
    (OUTPUT / "evaluation_protocol.sha256").write_text(sha256(protocol_path) + "\n")
    print("Frozen:", protocol["protocol_id"], sha256(protocol_path))


if __name__ == "__main__":
    main()
