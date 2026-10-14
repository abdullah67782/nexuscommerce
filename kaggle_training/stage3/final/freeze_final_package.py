"""Freeze amendments F1 and F2 and the final-evaluation package manifest (development data only).

Writes, refusing to overwrite once frozen:
  outputs/final_amendment_F1.json      decision protection research-only; excess cap = research stability check
  outputs/final_amendment_F2.json      final-machine reproduction preflight, tolerances and development prediction hashes
  outputs/final_package_manifest.json  every file the one-time evaluation adds to protocol v1, with sha256
  outputs/final_package_manifest.sha256
"""
import hashlib
import json
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
import calibrate as CAL  # noqa: E402
import u2_artifacts as U  # noqa: E402

D = C.D
OUT = C.STAGE3 / "outputs"
REPO = C.STAGE3.parents[1]
CAL_DIR = OUT / "final_prep" / "verification" / "laptop_run" / "calibration"
S3 = "kaggle_training/stage3"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_once(path, body):
    if path.exists():
        raise SystemExit(f"{path.name} is already frozen")
    path.write_text(json.dumps(body, indent=2) + "\n")
    return D.sha256(path)


def main():
    proto_sha = D.sha256(OUT / "final_protocol.json")
    freeze_sha = D.sha256(CAL_DIR / "calibration_freeze.json")
    freeze = json.loads((CAL_DIR / "calibration_freeze.json").read_text())

    f1 = {
        "amendment_id": "nexus-stage3-final-protocol-v1-amendment-F1",
        "base_protocol_sha256": proto_sha,
        "approved_by": "architect (Codex), after the development-anchored cap was frozen",
        "status_label": "RESEARCH ONLY (amendment F1): decision protection does not authorise promotion",
        "changes": [
            "The development-relative excess-stock cap (5/4 x the selected method's worst development ratio) is a RESEARCH STABILITY "
            "CHECK: it tests whether final behaviour stays within development behaviour. It is not an acceptable-cost criterion.",
            "All decision-protection results (A2 and A0) are research-only. Their checks are computed and reported exactly as in "
            "protocol v1, but no result, pass or fail, authorises a safety-stock suggestion, a promotion or any production change.",
            "Promotion of decision protection requires, in a future protocol with its own reservation: (i) a sequential inventory "
            "evaluation (multi-cycle replay with the Stage 2 engine: carried stock, open orders, lead times, review cycles), and "
            "(ii) an acceptable-cost criterion fixed in advance (for example shortage versus holding cost, or a seller-set trade-off).",
        ],
        "unchanged": ["A2 and A0 selections", "cap values", "coverage, shortage and excess computations", "all other gates of protocol v1"],
        "frozen_at": now(),
    }
    f1_sha = write_once(OUT / "final_amendment_F1.json", f1)

    sel = pickle.loads((OUT / "cache" / "SEL.pkl").read_bytes())
    rows, X = sel["rows"].loc[sel["rows"].method.notna()].copy(), sel["X"]
    preds = {f"{h}|{p}": hashlib.sha256(np.ascontiguousarray(U.predict(b, U.features(rows, X, h))).tobytes()).hexdigest()
             for (h, p), b in sorted(CAL.selected_u2().items())}
    env = freeze["source_run"]["environment"]
    f2 = {
        "amendment_id": "nexus-stage3-final-protocol-v1-amendment-F2",
        "base_protocol_sha256": proto_sha, "amendment_F1_sha256": f1_sha,
        "approved_by": "architect (Codex), after the cross-build U2 reproducibility finding",
        "rule": ("Before any reserved outcome is accessed and before the one-time lock is created, the final machine runs the preflight "
                 "(final/preflight.py). It verifies artifact hashes, reproduces the development prediction hashes, and recomputes the "
                 "calibration values for comparison within the tolerances below. On any failure the run stops. Nothing is retrained, "
                 "recalibrated in place or substituted; recomputed values are compared and discarded."),
        "environment": {"python_minor": env["python"].rsplit(".", 1)[0], "numpy": env["numpy"], "pandas": env["pandas"],
                        "scipy": env["scipy"], "xgboost": env["xgboost"]},
        "tolerances": {
            "forecast_units_abs": 1e-6,
            "parity_us_units": 1e-3, "parity_pk_units": 1e-2,
            "quantile_abs": 1e-9,
            "beta_abs": 1e-8,
            "counts_and_actuals": "exact",
            "selected_u2_predictions": "exact sha256 of the float32 prediction bytes",
        },
        "observed_on_calibration_machine": {"forecasts": "identical (max diff 0)", "quantiles": "identical",
                                            "pk_e1_beta_vs_development_machine": 5.551115123125783e-17,
                                            "selected_u2_prediction_hashes": "identical"},
        "development_prediction_sha256": {"selected_u2_sel": preds},
        "calibration_freeze_sha256": freeze_sha,
        "calibration_dir": str(CAL_DIR.relative_to(REPO)).replace("\\", "/"),
        "frozen_at": now(),
    }
    f2_sha = write_once(OUT / "final_amendment_F2.json", f2)

    rels = [f"{S3}/outputs/final_protocol.json", f"{S3}/outputs/final_protocol.sha256",
            f"{S3}/outputs/final_amendment_F1.json", f"{S3}/outputs/final_amendment_F2.json",
            f"{S3}/final/preflight.py", f"{S3}/final/final_execute.py"] + \
           [f2["calibration_dir"] + "/" + p.name for p in sorted(CAL_DIR.iterdir())]
    manifest = {
        "package": "nexus-stage3-final-evaluation-v1",
        "protocol_sha256": proto_sha, "amendments": {"F1": f1_sha, "F2": f2_sha}, "calibration_freeze_sha256": freeze_sha,
        "pakistan_source_sha256": json.loads((OUT / "final_protocol.json").read_text())["pakistan"]["source_sha256"],
        "files": {rel: D.sha256(REPO / rel) for rel in rels},
        "plus": "every file listed in final_protocol.json 'hashes' (42), verified separately",
        "entry_point": f"{S3}/final/final_execute.py",
        "frozen_at": now(),
    }
    m_sha = write_once(OUT / "final_package_manifest.json", manifest)
    (OUT / "final_package_manifest.sha256").write_text(f"{m_sha}  final_package_manifest.json\n")
    print(json.dumps({"F1": f1_sha, "F2": f2_sha, "manifest": m_sha, "calibration_freeze": freeze_sha, "protocol": proto_sha,
                      "u2_hashes": preds}, indent=1))


if __name__ == "__main__":
    main()
