"""Diagnostic 2 (development data only; changes no artifact, protocol or selection).

Diagnostic 1 showed the U2 training matrices differ between this laptop and the development machine, although
the stored frames are bit-identical. The only value computed on the fly is the feature log1p(F), so this script
  1. counts rows where this machine's np.log1p(F) differs from the development machine's value (bitwise, in ulps);
  2. replaces that column with the development values (cloud_log1p_reference.npz) and checks that the training
     matrices then hash exactly as on the development machine;
  3. retrains U2 on those identical inputs (development recipe, and without row sampling) and hashes the
     predictions on the SEL features, for comparison with the development machine.

    python u2_platform_diagnostic2.py <path to cloud_log1p_reference.npz>
Writes $NEXUS_WORK/artifacts/checks/u2_platform_diagnostic2.json
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

WORK = Path(os.environ["NEXUS_WORK"])
COL = 23   # position of log1p(F) in U2 features (23 v2 features, then log1p(F), history_days, sell_frac_180)


def h(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()[:16]


def ulps(a, b):
    ia, ib = a.view(np.int64), b.view(np.int64)
    return np.abs(ia - ib)


def main():
    ref = np.load(sys.argv[1])
    frames = pickle.loads((WORK / "cache" / "dev_frames.pkl").read_bytes())
    fit_parts = [frames["FIT_A"], frames["FIT_B"]]
    sel, Xsel = frames["SEL"]
    out = {"platform": platform.platform(), "numpy": np.__version__, "xgboost": xgb.__version__, "horizons": {}, "models": {}}
    fixed = {}
    for hz in U.HORIZONS:
        Xtr = np.vstack([U.features(r, X, hz) for r, X in fit_parts])
        ytr = np.concatenate([U.target(r, hz) for r, _ in fit_parts])
        Xs = U.features(sel, Xsel, hz)
        rec = {}
        for name, mine, theirs in (("fit", Xtr[:, COL], ref[f"log1p_fit_{hz}"]), ("sel", Xs[:, COL], ref[f"log1p_sel_{hz}"])):
            d = ulps(np.ascontiguousarray(mine), np.ascontiguousarray(theirs))
            rec[f"{name}_rows"] = int(len(d))
            rec[f"{name}_log1p_rows_differing"] = int((d > 0).sum())
            rec[f"{name}_log1p_max_ulp"] = int(d.max())
        Xtr[:, COL] = ref[f"log1p_fit_{hz}"]
        Xs[:, COL] = ref[f"log1p_sel_{hz}"]
        rec["X_sha_after_replacing_log1p"] = h(Xtr)
        rec["X_sel_sha_after_replacing_log1p"] = h(Xs)
        out["horizons"][str(hz)] = rec
        fixed[hz] = (Xtr, ytr, Xs)
        print(hz, rec, flush=True)
    for p in U.LEVELS:
        for hz in U.HORIZONS:
            Xtr, ytr, Xs = fixed[hz]
            rec = {}
            for name, ov in (("recipe", {}), ("no_sampling_2", {"subsample": 1.0})):
                t0 = time.time()
                m = xgb.XGBRegressor(**dict(U.RECIPE, quantile_alpha=p, **ov))
                m.fit(Xtr, ytr)
                rec[name] = {"pred_sha": h(U.predict(m.get_booster(), Xs)), "seconds": round(time.time() - t0, 1)}
            out["models"][f"{hz}|{p}"] = rec
            print(hz, p, {k: v["pred_sha"] for k, v in rec.items()}, flush=True)
    dest = WORK / "artifacts" / "checks"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "u2_platform_diagnostic2.json").write_text(json.dumps(out, indent=2))
    print("written", dest / "u2_platform_diagnostic2.json")


if __name__ == "__main__":
    main()
