"""Diagnostic only (development data; changes no artifact, protocol or selection).

Why does a fresh CPU retrain of U2 on Windows differ from the selected boosters (trained on Linux), while the
selected boosters predict identically on both? This script separates the possible causes:
  inputs   : sha256 of the exact training matrices (features and target) for each horizon
  selected : sha256 of the selected boosters' predictions on the SEL features (must match across machines)
  recipe   : the development recipe as frozen (subsample = 0.85, seed 42, n_jobs = 2)
  no_sampling_2 / no_sampling_1 : the same recipe with subsample = 1.0 (no random row sampling), n_jobs 2 and 1
If inputs and selected-booster predictions match across machines and the no-sampling variants also match, while
the recipe variant does not, the difference comes from the platform's random row sampling (the C++ standard
library's random distributions differ between compilers), not from the data or the method.

    python u2_platform_diagnostic.py            (needs NEXUS_WORK with cache/dev_frames.pkl from the 'reproduce' step)
Writes $NEXUS_WORK/artifacts/checks/u2_platform_diagnostic.json
"""
import hashlib
import json
import os
import pickle
import platform
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE3 = HERE.parent
sys.path.insert(0, str(STAGE3 / "final"))
sys.path.insert(0, str(STAGE3))

import numpy as np  # noqa: E402
import xgboost as xgb  # noqa: E402

import u2_artifacts as U  # noqa: E402
from calibrate import selected_u2  # noqa: E402

WORK = Path(os.environ["NEXUS_WORK"])


def h(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()[:16]


def train(fit_parts, hz, p, **override):
    Xtr = np.vstack([U.features(r, X, hz) for r, X in fit_parts])
    ytr = np.concatenate([U.target(r, hz) for r, _ in fit_parts])
    params = dict(U.RECIPE, quantile_alpha=p, **override)
    m = xgb.XGBRegressor(**params)
    m.fit(Xtr, ytr)
    return m.get_booster()


def main():
    frames = pickle.loads((WORK / "cache" / "dev_frames.pkl").read_bytes())
    fit_parts = [frames["FIT_A"], frames["FIT_B"]]
    sel, Xsel = frames["SEL"]
    chosen = selected_u2()
    out = {"platform": platform.platform(), "python": platform.python_version(), "numpy": np.__version__, "xgboost": xgb.__version__,
           "inputs": {}, "models": {}}
    for hz in U.HORIZONS:
        Xtr = np.vstack([U.features(r, X, hz) for r, X in fit_parts])
        ytr = np.concatenate([U.target(r, hz) for r, _ in fit_parts])
        out["inputs"][str(hz)] = {"X_sha": h(Xtr), "y_sha": h(ytr), "rows": int(len(ytr)), "X_sel_sha": h(U.features(sel, Xsel, hz))}
    for p in U.LEVELS:
        for hz in U.HORIZONS:
            f = U.features(sel, Xsel, hz)
            ref = U.predict(chosen[(hz, p)], f)
            rec = {"selected_pred_sha": h(ref)}
            for name, ov in (("recipe", {}), ("no_sampling_2", {"subsample": 1.0}), ("no_sampling_1", {"subsample": 1.0, "n_jobs": 1})):
                t0 = time.time()
                b = train(fit_parts, hz, p, **ov)
                pr = U.predict(b, f)
                rec[name] = {"pred_sha": h(pr), "max_abs_diff_vs_selected": float(np.max(np.abs(pr - ref))) if name == "recipe" else None,
                             "seconds": round(time.time() - t0, 1)}
            out["models"][f"{hz}|{p}"] = rec
            print(hz, p, {k: (v["pred_sha"] if isinstance(v, dict) else v) for k, v in rec.items()}, flush=True)
    dest = WORK / "artifacts" / "checks"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "u2_platform_diagnostic.json").write_text(json.dumps(out, indent=2))
    print("written", dest / "u2_platform_diagnostic.json")


if __name__ == "__main__":
    main()
