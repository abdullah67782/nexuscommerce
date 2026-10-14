"""Freeze amendment A2 and the complete final protocol (nexus-stage3-final-protocol-v1), with the hashes of every
file the calibration and the one-time final evaluation depend on. Development data only.

Writes (refuses to overwrite once frozen):
  outputs/dev_protocol_amendment_A2.json
  outputs/final_prep/dev_reference/*        (development values the Kaggle package must reproduce)
  outputs/final_protocol.json, outputs/final_protocol.sha256
"""
import json
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

D = C.D
OUT = C.STAGE3 / "outputs"
REPO = C.STAGE3.parents[1]
PREP = OUT / "final_prep"
REF = PREP / "dev_reference"
A2 = OUT / "dev_protocol_amendment_A2.json"
FINAL = OUT / "final_protocol.json"

PK_FINAL_EVENTS = [
    ["New Year", "2018-01-01", False, "fixed date"],
    ["Pakistan Day", "2018-03-23", False, "fixed public holiday"],
    ["Labour Day", "2018-05-01", False, "fixed public holiday"],
    ["Ramadan start", "2018-05-17", True, "first fast in Pakistan, 17 May 2018 (Ruet-e-Hilal); lunar spread applies before d-1"],
    ["Eid al-Fitr", "2018-06-16", True, "Pakistan, Saturday 16 June 2018 (Ruet-e-Hilal); lunar spread applies before d-1"],
    ["Independence Day", "2018-08-14", False, "fixed public holiday"],
    ["Eid al-Adha", "2018-08-22", True, "Pakistan declared Eid al-Adha on 22 August 2018 (Ruet-e-Hilal); lunar spread applies before d-1"],
]


def dev_reference():
    if (REF / "index.json").exists():
        return json.loads((REF / "index.json").read_text())
    REF.mkdir(parents=True, exist_ok=True)
    files = {}
    for name in ("FIT_A", "FIT_B", "CAL", "SEL"):
        d = pickle.loads((OUT / "cache" / f"{name}.pkl").read_bytes())
        r = d["rows"].loc[d["rows"].method.notna()].copy()
        r["series_key"] = r.store_id.astype(str) + "|" + r.item_id.astype(str)
        r[["series_key", "h", "origin", "F", "A", "group", "method"]].to_csv(REF / f"{name}.csv.gz", index=False, float_format="%.17g")
        files[f"{name}.csv.gz"] = None
    sel = pickle.loads((OUT / "cache" / "SEL.pkl").read_bytes())["rows"]
    sel = sel.loc[sel.method.notna()].copy()
    up = pickle.loads((OUT / "cache" / "sel_uppers.pkl").read_bytes())
    assert np.array_equal(up["index"], sel.index.to_numpy())
    ref = pd.DataFrame({"series_key": sel.store_id.astype(str) + "|" + sel.item_id.astype(str), "h": sel.h, "origin": sel.origin,
                        "u2_p0.8": up["uppers"][("U2", 0.8)], "u2_p0.9": up["uppers"][("U2", 0.9)]})
    ref.to_csv(REF / "SEL_U2_uppers.csv.gz", index=False, float_format="%.17g")
    files["SEL_U2_uppers.csv.gz"] = None
    # the CSV round trip must be exact
    back = pd.read_csv(REF / "SEL_U2_uppers.csv.gz", float_precision="round_trip")
    assert np.array_equal(back["u2_p0.8"].to_numpy(), ref["u2_p0.8"].to_numpy())
    files = {k: D.sha256(REF / k) for k in files}
    index = {"what": "development values (cloud development run) that the Kaggle package must reproduce", "files": files}
    (REF / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    return index


def amendment_a2(recheck):
    dec = recheck["decisions"]
    body = {
        "amendment_id": "nexus-stage3-dev-protocol-v1-amendment-A2",
        "base_protocol_sha256": (OUT / "dev_protocol.sha256").read_text().split()[0],
        "amendment_A1_sha256": D.sha256(OUT / "dev_protocol_amendment_A1.json"),
        "approved_by": "architect (Codex) decision D2, after development results were seen",
        "disclosure": ("Made AFTER the development decision-track results were seen. The original selections (rule A0: kappa = 1 only) "
                       "are preserved below and are evaluated and reported in the final run, but they do not authorise a suggestion."),
        "reason": ("D1 protects only the variability of demand inside the review window. With starting stock above the point forecast "
                   "(kappa = 1.5) it counts the projected surplus as available, and development coverage fell to 0.601-0.833 for the cells "
                   "where it was selected."),
        "rule_A2": ("A candidate is eligible only if, with exact integer arithmetic, |hits - p*n| <= tol*n on every (L, R) pair and both "
                    "scenarios at kappa = 1 AND on (7, 7) at kappa 0.5 and 1.5 in both scenarios, with >= 200 decisions per cell; "
                    "tol = 0.05 (0.10 rare). Among eligible candidates the lowest mean order quantity at kappa = 1 is selected; none -> no suggestion."),
        "selections_A0_original": dec["A0_original_exact"],
        "selections_A2": dec["A2_kappa_robust_exact"],
        "correction_to_the_development_report": ("The report (section 6.3) read rounded coverages and stated that A2 would select D2c@0.9 for "
                                                 "regular 90% and keep D2c@0.8 for occasional 80%. Exactly: D2c@0.9 regular reaches 0.848 at "
                                                 "kappa 1.5 (below 0.85), so A2 selects D2@0.9; occasional 80% has no eligible candidate "
                                                 "(D2c@0.8 reaches 0.852 at kappa 0.5, above 0.85)."),
        "decision_specific_quantity": ("Every candidate is evaluated on the order quantity it produces for each decision. Q_method - Q_D0 "
                                       "is not a safety stock: with Stage 2's daily checkpoints a safety-stock setting SS changes the "
                                       "quantity to max(-min balance, SS - end balance), which is not Q_D0 + SS in general. Any later "
                                       "implementation must reproduce the evaluated quantity for each decision."),
        "excess_stock_gate": ("Per selected (segment, level): in every cell, shortage avoided per decision versus D0 > 0 and "
                              "(mean end stock - D0 mean end stock) / (D0 mean lost units - mean lost units) <= cap, exactly; "
                              "cap = 5/4 x the selected method's worst development ratio over all A2 cells; plus the date-block 95% "
                              "interval of the pooled per-decision shortage reduction (kappa = 1) above 0."),
        "caps": dec["caps"],
        "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    text = json.dumps(body, indent=2) + "\n"
    if A2.exists():
        old = json.loads(A2.read_text())
        old.pop("frozen_at"), body.pop("frozen_at")
        if old != body:
            raise SystemExit("amendment A2 already frozen with different content")
        return json.loads(A2.read_text())
    A2.write_text(text)
    return body


HASHED = [
    "kaggle_training/stage3/data_access.py", "kaggle_training/stage3/served.py", "kaggle_training/stage3/events.py",
    "kaggle_training/stage3/e1_layer.py", "kaggle_training/stage3/u2_artifacts.py",
    "kaggle_training/stage3/final/common.py", "kaggle_training/stage3/final/calibrate.py",
    "kaggle_training/stage3/final/final_access.py", "kaggle_training/stage3/final/final_runner.py",
    "kaggle_training/stage3/kaggle/pkg_steps.py", "kaggle_training/stage3/kaggle/pins.json",
    "ml/v2/__init__.py", "ml/v2/features.py", "ml/v2/forecast.py", "ml/v2/methods.py", "ml/v2/registry.py",
    "ml/models_v2/manifest.json", "ml/models_v2/shared_total_7.json", "ml/models_v2/shared_total_28.json",
    "data/m5/calendar.csv", "data/m5/sales_train_evaluation.csv.zip", "data/m5/sell_prices.csv.zip",
    "kaggle_training/stage3/data_dev/pakistan_dev_2016-07-01_2017-12-31.csv", "kaggle_training/stage3/data_dev/pakistan_dev_manifest.json",
    "kaggle_training/stage3/outputs/reservation_m5.json", "kaggle_training/stage3/outputs/dev_protocol.json",
    "kaggle_training/stage3/outputs/dev_protocol_amendment_A1.json", "kaggle_training/stage3/outputs/dev_protocol_amendment_A2.json",
    "kaggle_training/stage3/outputs/us/uncertainty_selection.json", "kaggle_training/stage3/outputs/us/decision_selection.json",
    "kaggle_training/stage3/outputs/final_prep/exact_recheck.json",
    "kaggle_training/stage3/outputs/u2_selected/index.json",
    "kaggle_training/stage3/outputs/u2_selected/U2_h7_p0.8.json", "kaggle_training/stage3/outputs/u2_selected/U2_h28_p0.8.json",
    "kaggle_training/stage3/outputs/u2_selected/U2_h7_p0.9.json", "kaggle_training/stage3/outputs/u2_selected/U2_h28_p0.9.json",
] + [f"kaggle_training/stage3/outputs/research_models/R1{k}_{h}.json" for k in (2, 3, 4) for h in (7, 28)]


def main():
    if FINAL.exists():
        raise SystemExit("final_protocol.json is already frozen; a change needs a new protocol version")
    recheck = json.loads((PREP / "exact_recheck.json").read_text())
    if not (recheck["totals_matches_frozen_dev"] and recheck["decisions"]["A0_matches_frozen_dev"]):
        raise SystemExit("exact recheck does not reproduce the frozen development selections")
    ref = dev_reference()
    a2 = amendment_a2(recheck)
    totals = {k: v["exact_choice"] for k, v in recheck["totals_uncertainty"].items()}
    manifest = json.loads((REPO / "ml" / "models_v2" / "manifest.json").read_text())
    pk_manifest = json.loads((C.STAGE3 / "data_dev" / "pakistan_dev_manifest.json").read_text())
    protocol = {
        "protocol_id": "nexus-stage3-final-protocol-v1",
        "status": "frozen before any calibration artifact is generated and before any reserved outcome is read",
        "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "production_unchanged": ["nexus-v2-shared-20261008 models and hashes", "routing rule", "replenishment-1",
                                 "no production integration or model replacement is authorised by this protocol"],
        "base_release": {"release": manifest["release"], "models": {h: v["sha256"] for h, v in manifest["models"].items()}},
        "corrections": {
            "1_exact_thresholds": "every tolerance, count and ratio check uses unrounded integer/Fraction arithmetic (final/common.py); displayed values are never compared",
            "2_shortage_excess_gate": a2["excess_stock_gate"],
            "3_decision_specific_quantities": a2["decision_specific_quantity"],
            "4_executable_protocol": "final/final_runner.py implements this protocol end to end; rehearsed on development stand-ins before freezing calibration",
        },
        "decisions_applied": {"D1": "E1c carried into the US final run, reported under the event gates",
                              "D2": "kappa-robust rule A2 (amendment A2), original A0 selections preserved and reported",
                              "D3": "Pakistan E1 only for Independence Day and Eid al-Adha (two fit occurrences each), alpha = 10",
                              "D4": "calibration plan and this protocol frozen; calibration artifacts hashed before final outcomes"},
        "selections": {
            "totals_uncertainty": totals,
            "decision_A0_original": recheck["decisions"]["A0_original_exact"],
            "decision_A2_kappa_robust": recheck["decisions"]["A2_kappa_robust_exact"],
            "decision_authorising_rule": "A2_kappa_robust",
            "decision_caps": recheck["decisions"]["caps"],
            "event_us": "E1c (25 December closure: F x (h - closed days)/h for F >= 1); learned E1 not carried",
            "event_pk": {"events": ["Independence Day", "Eid al-Adha"], "alpha": 10, "form": "F x exp(x . beta) for F >= 1"},
            "safety_stock_targets": [0.8, 0.9],
        },
        "us": {
            "products": "reservation nexus-stage3-m5-v1 holdout: 90 products x 10 stores, launch = first price week",
            "final_windows_within": ["2015-11-01", "2016-05-22"], "origins": "every 7 days from the first date", "horizons": [7, 28],
            "rehearsal_windows_within": ["2014-11-01", "2015-05-31"], "rehearsal_products": "development_extra (150)",
            "calibration": {"script": "final/calibrate.py --market us", "products": "consumed (180) + development_extra (150) x 10 stores",
                            "windows_within": ["2015-06-01", "2015-10-31"], "origins": "every 7 days",
                            "quantities": ["U0 and U1 quantiles per segment x horizon x level", "U2 conformal corrections (selected CPU boosters)", "D1 r_p"]},
            "decision_track": {"pairs": [list(x) for x in C.PAIRS], "excluded": "L14/R14 (29 days > 28)", "kappa": "1 for every pair; 0.5 and 1.5 on (7, 7)",
                               "scenarios": list(C.SCENARIOS), "paths": C.J_PATHS,
                               "success": "no shortage on any day of the review window a..a+R-1 (a = L + 2) on actual daily sales",
                               "shortage_before_arrival": "reported separately", "lost_units": "lower bound where stockouts are unknown"},
        },
        "pakistan": {
            "series": "15 named categories (uncategorised reported separately); recorded order quantities (no order status)",
            "source_sha256": pk_manifest["source_sha256"],
            "final_windows_within": ["2018-01-01", "2018-08-28"], "rehearsal_windows_within": ["2017-07-01", "2017-12-31"],
            "final_event_dates": [e[:3] for e in PK_FINAL_EVENTS], "final_event_sources": {f"{e[0]} {e[1]}": e[3] for e in PK_FINAL_EVENTS},
            "calibration": {"script": "final/calibrate.py --market pk", "uncertainty_windows_within": ["2017-07-01", "2017-12-31"],
                            "e1_fit_windows_within": ["2016-07-29", "2017-12-31"]},
            "uncertainty": "U0/U1 coverage is descriptive only: 15 category series are below the 30-series requirement and are not inventory units",
        },
        "gates": {
            "event": ("event-window WAPE >= 5% better than the frozen release at both horizons; overall and non-event WAPE no worse than "
                      "+0.5 points; |event bias| not larger; date-block and product (US) / category (PK) cluster 95% intervals of the "
                      "relative improvement above 0; >= 2 fit occurrences per adjusted event. PK event windows = windows overlapping "
                      "[d-7, d+3] of the adjusted events."),
            "totals_uncertainty": ("for the selected method of each cell: exact |hits - p*n| <= tol*n in event AND non-event windows; "
                                   ">= 200 windows; >= 30 series; >= 2 distinct primary-event occurrences in the cell's event windows"),
            "decision_protection": ("A2 cells: exact coverage tolerance in every cell; >= 200 decisions per cell; shortage avoided > 0 and "
                                    "excess-per-avoided ratio <= the frozen cap in every cell; pooled shortage-reduction date-block 95% interval above 0"),
            "parity": "max |served - ml/v2 forecast_totals| < 1e-3 units on 300 sampled US forecasts (< 1e-2 for PK category totals); otherwise stop",
            "scope": "a pass authorises a suggestion only for the evaluated market, segment, horizon and level; no production change is authorised",
        },
        "coverage_definition": "share of windows whose actual total is <= the method's upper p-quantile (one-sided); windows without a v2 forecast are excluded",
        "statistics": {"date_block_days": C.BLOCK_DAYS, "bootstrap_B": C.BOOT_B, "cluster": "products (US), categories (PK)"},
        "seeds": {"decisions": 20261015, "u3": 7, "bootstrap": 20261017},
        "execution": {
            "runner": "kaggle_training/stage3/final/final_runner.py",
            "rehearsal": "python final_runner.py --rehearse --calibration <dir> --out <dir>",
            "final": ("python final_runner.py --execute-once --confirm <sha256(final_protocol.json)> --calibration <dir> "
                      "--calibration-freeze-sha <sha256(calibration_freeze.json)> --pakistan-source <csv> --lock-dir <dir> --out <empty dir>"),
            "rerun_protection": ("hash checks; lock file created with O_CREAT|O_EXCL; non-empty output refused; the returned evidence is accepted "
                                 "once, matched to the calibration freeze and protocol hashes"),
            "calibration_freeze": "calibration_freeze.json lists the verified calibration artifacts with hashes; made after verification of the Kaggle output and before the final package",
        },
        "development_reference": ref,
        "hashes": {rel: D.sha256(REPO / rel) for rel in HASHED},
    }
    FINAL.write_text(json.dumps(protocol, indent=2) + "\n")
    sha = D.sha256(FINAL)
    (OUT / "final_protocol.sha256").write_text(f"{sha}  final_protocol.json\n")
    print("A2 selections:", a2["selections_A2"])
    print("final protocol frozen:", sha)


if __name__ == "__main__":
    main()
