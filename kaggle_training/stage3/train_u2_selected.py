"""Re-create the development-selected U2 boosters as saved artifacts (CPU, development recipe and data).

Run in the development environment. It must reproduce the development SEL upper bounds exactly
(outputs/cache/sel_uppers.pkl); otherwise it stops and saves nothing.
Writes outputs/u2_selected/U2_h{7,28}_p{0.8,0.9}.json and u2_selected/index.json.
"""
import json
import pickle

import numpy as np
import xgboost as xgb

import data_access as D
import u2_artifacts as U

OUT = D.STAGE3 / "outputs"
CACHE = OUT / "cache"
DEST = OUT / "u2_selected"


def load(name):
    d = pickle.loads((CACHE / f"{name}.pkl").read_bytes())
    return d["rows"].loc[d["rows"].method.notna()].copy(), d["X"]


def main():
    fit_parts = [load("FIT_A"), load("FIT_B")]
    cal, Xcal = load("CAL")
    sel, Xsel = load("SEL")
    ref = pickle.loads((CACHE / "sel_uppers.pkl").read_bytes())
    assert np.array_equal(ref["index"], sel.index.to_numpy())
    DEST.mkdir(parents=True, exist_ok=True)
    index = {"recipe": U.RECIPE, "device": "cpu", "xgboost": xgb.__version__, "training": "FIT_A (R12) + FIT_B (R13) weekly rows",
             "conformal_calibration_dev": "CAL (R14) 2014-06..10", "models": {}}
    for p in U.LEVELS:
        dev = ref["uppers"][("U2", p)]
        for h in U.HORIZONS:
            b = U.train(fit_parts, h, p, device="cpu")
            corr = U.corrections(b, cal, Xcal, h, p)
            up = U.uppers(b, corr, sel, Xsel, h)
            pos = np.flatnonzero((sel.h == h).to_numpy())
            diff = float(np.max(np.abs(up - dev[pos])))
            print(f"h={h} p={p} max |upper - development upper| = {diff}", flush=True)
            if diff != 0.0:
                raise SystemExit("not an exact reproduction of the development U2; nothing saved")
            name = f"U2_h{h}_p{p}.json"
            b.save_model(str(DEST / name))
            again = xgb.Booster()
            again.load_model(str(DEST / name))
            assert np.array_equal(U.predict(again, U.features(sel, Xsel, h)), U.predict(b, U.features(sel, Xsel, h)))
            index["models"][f"{h}|{p}"] = {"file": name, "sha256": D.sha256(DEST / name),
                                           "dev_corrections": corr, "dev_sel_reproduction_max_abs_diff": diff}
    (DEST / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print("saved", DEST)


if __name__ == "__main__":
    main()
