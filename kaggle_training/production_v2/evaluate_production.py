"""Step 4: evaluate the frozen v2 production models ONCE on the fresh holdout.

Forecasts come from the application's own code (ml/v2): models are loaded by
the registry (manifest hash checks) and totals come from forecast_totals().
No fitting, tuning or method selection happens here. Refuses to run twice.
"""
import argparse
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from common import OUTPUT, ROOT, m5_paths, read_json, sha256, versions, write_json
from reserved_final_evaluation import read_reserved
from v2 import methods
from v2.forecast import forecast_totals, shared_model_total
from v2.registry import load_models


def verify_frozen():
    protocol_path = OUTPUT / "evaluation_protocol.json"
    if sha256(protocol_path) != (OUTPUT / "evaluation_protocol.sha256").read_text().strip():
        raise ValueError("Evaluation protocol changed after freezing.")
    protocol = read_json(protocol_path)
    for relative, expected in protocol["file_hashes"].items():
        if sha256(ROOT / relative) != expected:
            raise ValueError(f"Frozen file changed: {relative}")
    calendar, sales, prices = m5_paths()
    if {"calendar": sha256(calendar), "sales": sha256(sales), "prices": sha256(prices)} != protocol["sources"]:
        raise ValueError("Source data changed.")
    return protocol


def score(rows):
    error = rows.forecast - rows.actual
    total = rows.actual.sum()
    return {"WAPE_percent": float(100 * error.abs().sum() / total) if total else None,
            "MAE_total_units": float(error.abs().mean()),
            "bias_percent": float(100 * error.sum() / total) if total else None,
            "actual_units": float(total), "rows": int(len(rows)), "windows": int(rows.start.nunique()),
            "series": int(rows.groupby(["store", "item_id"]).ngroups)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute-once", action="store_true")
    if not parser.parse_args().execute_once:
        parser.error("Holdout outcomes stay sealed until --execute-once.")
    protocol = verify_frozen()
    output = OUTPUT / "evaluation_results"
    if output.exists():
        raise FileExistsError("Evaluation already ran; preserve its evidence and do not rerun.")
    output.mkdir()
    write_json(output / "started.json", {"protocol_sha256": sha256(OUTPUT / "evaluation_protocol.json"),
                                         "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    models, manifest = load_models()  # the application's loader
    calendar, sales, prices = m5_paths()
    reader = {"sources": {"calendar": {"path": str(calendar)}, "sales": {"path": str(sales)}, "prices": {"path": str(prices)}},
              "evaluation_end": protocol["evaluation_end"], "training_end": protocol["training_end"],
              "reserved_products": protocol["holdout"]["products"], "target_stores": protocol["holdout"]["stores"]}
    data, eligibility = read_reserved(reader)
    eligibility.to_csv(output / "eligibility_all_pairs.csv", index=False)

    rows = []
    for (store, item_id), series in data.groupby(["store_id", "item_id"], sort=True):
        series = series.sort_values("date")
        dates, values = series.date.to_numpy(), series.sales.to_numpy(dtype=float)
        first = pd.Timestamp(dates[0]).date()
        for window in protocol["windows"]:
            horizon, start, end = window["horizon"], pd.Timestamp(window["start"]), pd.Timestamp(window["end"])
            history = values[dates < np.datetime64(start)]
            future = values[(dates >= np.datetime64(start)) & (dates <= np.datetime64(end))]
            if len(future) != horizon:
                raise ValueError("Incomplete evaluation window; do not drop it silently.")
            served = forecast_totals(first, history, models)
            forecast = next(f for f in served["forecasts"] if f["horizon_days"] == horizon)
            if forecast["start"] != str(start.date()) or served["history"]["tier"] != "model":
                raise AssertionError("Unexpected origin or tier for an eligible pair.")
            candidates = {"v2_rule": forecast["total_units"],
                          "shared_model": shared_model_total(models[horizon], history, start.date(), horizon),
                          "tsb": methods.tsb_total(history, horizon), "mean_28": methods.mean_28_total(history, horizon)}
            for method, value in candidates.items():
                rows.append({"store": store, "item_id": item_id, "horizon": horizon, "start": window["start"], "end": window["end"],
                             "group": served["pattern"]["group"], "served_method": forecast["method"], "method": method,
                             "forecast": float(value), "actual": float(future.sum())})
    predictions = pd.DataFrame(rows)
    predictions.to_csv(output / "predictions.csv", index=False)

    overall = [dict(horizon=h, method=m, **score(g)) for (h, m), g in predictions.groupby(["horizon", "method"])]
    by_store = [dict(store=s, horizon=h, method=m, **score(g)) for (s, h, m), g in predictions.groupby(["store", "horizon", "method"])]
    by_group = [dict(group=p, horizon=h, method=m, **score(g)) for (p, h, m), g in predictions.groupby(["group", "horizon", "method"])]
    pd.DataFrame(overall).to_csv(output / "metrics_overall.csv", index=False)
    pd.DataFrame(by_store).to_csv(output / "metrics_by_store.csv", index=False)
    pd.DataFrame(by_group).to_csv(output / "metrics_by_group.csv", index=False)
    per_product = [dict(store=s, item_id=i, horizon=h, method=m, **score(g))
                   for (s, i, h, m), g in predictions.groupby(["store", "item_id", "horizon", "method"])]
    pd.DataFrame(per_product).to_csv(output / "metrics_by_product.csv", index=False)
    verify_frozen()
    write_json(output / "run_complete.json", {
        "protocol_sha256": sha256(OUTPUT / "evaluation_protocol.json"), "models_release": manifest["release"],
        "pairs": int(len(eligibility)), "eligible_pairs": int(eligibility.eligible.sum()),
        "prediction_rows": int(len(predictions)), "versions": versions(),
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "no_tuning": True})
    print(pd.DataFrame(overall).round(3).to_string(index=False))


if __name__ == "__main__":
    main()
