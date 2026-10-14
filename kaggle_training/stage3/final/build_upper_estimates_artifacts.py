"""Build the application artifacts for upper-estimates-1 from the CONSUMED final evaluation (read-only).

Approved scope (architect, 2026-10-13): one-sided upper demand estimates for the 12 US totals-uncertainty
cells that passed the one-time final evaluation (regular, occasional and rare x 7/28 days x 80/90%), with the
exact method evaluated in each cell. Nothing is re-estimated here: the calibration values and the U2 booster
are copied byte-for-byte from the frozen artifacts (hash-checked against protocol v1 / manifest v2), and the
benchmark figures are copied from the final evaluation's own output (hash-checked against its SHA256SUMS).

Writes ml/upper_estimates_v1/: calibration_us.json, U2_h7_p0.8.json, policy.json, manifest.json.

    python build_upper_estimates_artifacts.py [--out DIR]
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

STAGE3 = Path(__file__).resolve().parents[1]
ROOT = STAGE3.parents[1]
OUT = STAGE3 / "outputs"
FINAL = OUT / "final_results" / "evaluation"
CAL = OUT / "final_prep" / "verification" / "laptop_run" / "calibration"
U2 = OUT / "u2_selected"

VERSION = "upper-estimates-1"
POLICY_VERSION = "upper-estimates-policy-1"
PROTOCOL_SHA = "8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af"
MANIFEST_V2_SHA = "6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e"
FINAL_SUMS_SHA = "16d1d9a691a6aad8e30a2942e8c2e93dcdcdb414e3e5f6ab4850f84de38547c1"
SEGMENTS = ("regular", "occasional", "rare")
METHOD_LABELS = {
    "U0": "Forecast-error ratio from benchmark history",
    "U1": "Conformal score from benchmark history",
    "U2": "Quantile model with conformal correction",
    "U3": "Rare-sales simulation (TSB bootstrap, 400 draws)",
}
LIMITATIONS = [
    "Evaluated on US Walmart benchmark data; not calibrated to your store.",
    "The benchmark is the M5 data set: food, household and hobby products in 10 Walmart stores in California, "
    "Texas and Wisconsin. The one-time check used 7- and 28-day windows from November 2015 to May 2016.",
    "This is a one-sided upper estimate of demand, not a range: there is no lower estimate. It is not a guarantee "
    "and not an order quantity.",
    "In the benchmark it was checked only as \"actual sales at or below the estimate\"; how often that holds for "
    "your products can differ (other prices, promotions, customers or stock-outs).",
    "Sales recorded while out of stock understate demand, so the estimate can be low for products that often run out.",
    "Your reorder suggestions and your safety stock do not use this estimate.",
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def check(cond, msg):
    if not cond:
        raise SystemExit(f"refusing to build: {msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "ml" / "upper_estimates_v1"))
    out = Path(ap.parse_args().out)

    protocol = json.loads((OUT / "final_protocol.json").read_text())
    check(sha256(OUT / "final_protocol.json") == PROTOCOL_SHA, "final protocol hash")
    pkg = json.loads((OUT / "final_package_manifest.json").read_text())
    check(sha256(OUT / "final_package_manifest.json") == MANIFEST_V2_SHA, "package manifest v2 hash")

    # The consumed final evaluation: verify its checksum list, then every file it lists that is used here.
    sums_path = FINAL / "SHA256SUMS"
    check(sha256(sums_path) == FINAL_SUMS_SHA, "final evaluation SHA256SUMS hash")
    sums = {}
    for line in sums_path.read_bytes().decode().replace("\r\n", "\n").splitlines():
        h, name = line.split("  ", 1)
        sums[name] = h
    for name in ("STATUS.json", "gates_summary.json", "us_totals_cells.json", "results.json"):
        check(sha256(FINAL / name) == sums[name], f"{name} does not match the final SHA256SUMS")
    status = json.loads((FINAL / "STATUS.json").read_text())
    check(status["status"] == "COMPLETED" and status["mode"] == "final", "final evaluation not completed")
    gates = json.loads((FINAL / "gates_summary.json").read_text())["promotion_gates"]["totals_uncertainty_cells_pass"]
    cells_all = json.loads((FINAL / "us_totals_cells.json").read_text())
    results = json.loads((FINAL / "results.json").read_text())
    selections = protocol["selections"]["totals_uncertainty"]

    # Frozen artifacts, byte-for-byte.
    cal_rel = "kaggle_training/stage3/outputs/final_prep/verification/laptop_run/calibration/calibration_us.json"
    check(sha256(CAL / "calibration_us.json") == pkg["files"][cal_rel], "calibration_us.json hash (manifest v2)")
    u2_rel = "kaggle_training/stage3/outputs/u2_selected/U2_h7_p0.8.json"
    check(sha256(U2 / "U2_h7_p0.8.json") == protocol["hashes"][u2_rel], "U2_h7_p0.8.json hash (protocol v1)")
    calib = json.loads((CAL / "calibration_us.json").read_text())

    cells, used_u2 = {}, False
    for seg in SEGMENTS:
        for h in (7, 28):
            for p in (0.8, 0.9):
                key = f"{seg}|{h}|{p}"
                check(gates.get(key) is True, f"{key} did not pass the final evaluation")
                method = selections[key]
                rec = [c for c in cells_all if c["cell"] == key and c.get("selected")]
                check(len(rec) == 1 and rec[0]["method"] == method, f"{key}: selected record/method mismatch")
                r = rec[0]
                cell = {
                    "method": method, "method_label": METHOD_LABELS[method],
                    "benchmark": {
                        "coverage": r["coverage_all"], "coverage_event_windows": r["coverage_event"],
                        "coverage_other_windows": r["coverage_non_event"], "windows": r["windows"], "series": r["series"],
                        "coverage_date_block_95": r["coverage_date_block_95"], "tolerance_points": 10 if seg == "rare" else 5,
                        "target": p,
                    },
                }
                if method == "U0":
                    cell["parameter"] = {"ratio_quantile": calib["U0"][key]}
                elif method == "U1":
                    cell["parameter"] = {"score_quantile": calib["U1"][key]}
                elif method == "U2":
                    check((h, p) == (7, 0.8), "only the 7-day 80% booster is approved")
                    cell["parameter"] = {"booster": "U2_h7_p0.8.json", "correction": calib["U2_correction"][key]}
                    used_u2 = True
                else:
                    check(method == "U3" and seg == "rare", "U3 is the rare-product simulation")
                    cell["parameter"] = {"draws": 400, "history_days_for_sizes": 180, "beta": 0.1}
                cells[key] = cell
    check(used_u2, "the U2 cell is missing")

    unsupported = {}
    for key, g in results["us"]["totals_gates"].items():
        seg = key.split("|")[0]
        if seg in SEGMENTS:
            continue
        unsupported.setdefault(seg, []).append({"cell": key, "reason": g.get("reason") or ", ".join(
            k for k, v in g.items() if v is False and k != "pass")})

    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(CAL / "calibration_us.json", out / "calibration_us.json")
    shutil.copyfile(U2 / "U2_h7_p0.8.json", out / "U2_h7_p0.8.json")
    policy = {
        "version": VERSION, "policy_version": POLICY_VERSION, "kind": "one-sided upper demand estimate",
        "evaluated_release": protocol["base_release"]["release"],
        "evaluated_routes": {"regular": "shared_model", "occasional": "shared_model", "rare": "tsb"},
        "min_history_days": 180, "levels": [0.8, 0.9], "horizons": [7, 28],
        "benchmark": {"name": "M5 (US Walmart)", "stores": 10, "states": ["CA", "TX", "WI"],
                      "departments": ["foods", "household", "hobbies"], "products": "90 held-back products x 10 stores",
                      "windows_within": results["us"]["windows_within"], "series": results["us"]["series"]},
        "cells": cells,
        "not_supported": {
            "dormant": {"text": "No upper-estimate method met the benchmark checks for products with no sales in the last 180 days.",
                        "final_cells": unsupported.get("dormant", [])},
            "short_history": {"text": "Products with fewer than 180 confirmed days could not be validated: the benchmark had only 86 windows from 11 products.",
                              "final_cells": unsupported.get("short_history", [])},
            "pakistan": {"text": "Pakistan results were descriptive only: 90% and 28-day estimates were outside the coverage tolerance and very wide."},
        },
        "limitations": LIMITATIONS,
        "source": {"protocol_sha256": PROTOCOL_SHA, "package_manifest_sha256": MANIFEST_V2_SHA,
                   "final_evaluation_sha256sums": FINAL_SUMS_SHA, "us_totals_cells_sha256": sums["us_totals_cells.json"],
                   "gates_summary_sha256": sums["gates_summary.json"]},
    }
    (out / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")
    manifest = {
        "version": VERSION, "policy_version": POLICY_VERSION, "evaluated_release": policy["evaluated_release"],
        "xgboost_version": json.loads((U2 / "index.json").read_text())["xgboost"],
        "files": {n: sha256(out / n) for n in ("calibration_us.json", "U2_h7_p0.8.json", "policy.json")},
        "frozen_sources": {"calibration_us.json": cal_rel, "U2_h7_p0.8.json": u2_rel},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v for k, v in manifest.items() if k != "frozen_sources"}, indent=2))


if __name__ == "__main__":
    main()
