"""Final-machine reproduction preflight (amendment nexus-stage3-final-protocol-v1-amendment-F2).

Runs BEFORE any reserved outcome is accessed and before the one-time lock is created. Development data only.
It never retrains, recalibrates in place, or substitutes an artifact: the recomputed values are compared with the
frozen ones and then discarded. Any failed check stops the run.

Checks (tolerances are fixed in amendment F2, read from final_amendment_F2.json):
  P1 environment      python minor version and library versions equal the frozen calibration environment
  P2 hashes           final protocol v1 + its 42 listed files; amendments F1/F2; final package manifest files;
                      calibration freeze + artifacts; Pakistan source bytes (when given)
  P3 development frames research copies R14 re-serve CAL and SEL: same rows, groups, methods and actuals;
                      max |F - development F| <= tol_forecast_units; parity with ml/v2 forecast_totals
  P4 selected U2      predictions of the stored selected boosters on the SEL features: sha256 equal to development
  P5 calibration rows frozen release re-serves the US and PK calibration windows: same rows/actuals,
                      max |F - frozen F| <= tol_forecast_units
  P6 calibration      recomputed U0/U1 quantiles, U2 corrections, D1 r_p, counts and PK E1 beta versus the frozen
                      calibration, within tol_quantile / tol_beta; counts exact
"""
import hashlib
import json
import platform
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import scipy
import xgboost as xgb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import calibrate as CAL  # noqa: E402
import u2_artifacts as U  # noqa: E402

D = C.D
OUT = C.STAGE3 / "outputs"
REPO = C.STAGE3.parents[1]
F1 = OUT / "final_amendment_F1.json"
F2 = OUT / "final_amendment_F2.json"
MANIFEST = OUT / "final_package_manifest.json"


def sha_bytes(a):
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


class Report:
    def __init__(self, log):
        self.checks, self.log = [], log

    def add(self, cid, name, ok, **detail):
        self.checks.append({"id": cid, "check": name, "pass": bool(ok), **detail})
        self.log(f"{'PASS' if ok else 'FAIL'} {cid} {name}" + (f" {detail}" if detail and not ok else ""))
        return ok

    @property
    def ok(self):
        return all(c["pass"] for c in self.checks)


def _cmp_rows(rows, ref, tol):
    m = rows.merge(ref, on=["series_key", "h", "origin"], how="outer", suffixes=("", "_ref"), indicator=True)
    both = m["_merge"] == "both"
    dF = (m.loc[both, "F"] - m.loc[both, "F_ref"]).abs()
    return {"rows": int(len(rows)), "rows_reference": int(len(ref)), "rows_only_here": int((m["_merge"] == "left_only").sum()),
            "rows_only_reference": int((m["_merge"] == "right_only").sum()),
            "actuals_identical": bool((m.loc[both, "A"] == m.loc[both, "A_ref"]).all()),
            "groups_identical": bool((m.loc[both, "group"] == m.loc[both, "group_ref"]).all()),
            "methods_identical": bool((m.loc[both, "method"] == m.loc[both, "method_ref"]).all()),
            "max_abs_F_diff": float(dF.max()) if len(dF) else None, "tolerance": tol}


def _rows_ok(d):
    return (d["rows_only_here"] == 0 and d["rows_only_reference"] == 0 and d["actuals_identical"] and d["groups_identical"]
            and d["methods_identical"] and d["max_abs_F_diff"] is not None and d["max_abs_F_diff"] <= d["tolerance"])


def _dict_diff(a, b):
    keys = set(a) | set(b)
    missing = sorted(k for k in keys if k not in a or k not in b)
    worst = max((abs(a[k] - b[k]) for k in keys if k in a and k in b), default=0.0)
    return missing, float(worst)


def run(cal_dir, freeze_sha, manifest_sha, pakistan_source=None, allow_unpinned=False, log=print):
    cal_dir = Path(cal_dir)
    rep = Report(log)
    f2 = json.loads(F2.read_text())
    tol = f2["tolerances"]

    # P1 environment
    env = {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scipy": scipy.__version__,
           "xgboost": xgb.__version__, "platform": platform.platform()}
    req = f2["environment"]
    env_ok = (env["python"].rsplit(".", 1)[0] == req["python_minor"] and all(env[k] == req[k] for k in ("numpy", "pandas", "scipy", "xgboost")))
    rep.add("P1", "environment equals the frozen calibration environment", env_ok or allow_unpinned, environment=env, required=req,
            reference_override=bool(allow_unpinned and not env_ok))

    # P2 hashes
    from final_runner import PROTOCOL, PROTOCOL_SHA, verify_hashes, verify_calibration
    proto_sha = D.sha256(PROTOCOL)
    rep.add("P2a", "final protocol v1 matches its frozen hash", PROTOCOL_SHA.read_text().split()[0] == proto_sha == f2["base_protocol_sha256"],
            protocol_sha256=proto_sha)
    bad = verify_hashes(json.loads(PROTOCOL.read_text()), REPO)
    rep.add("P2b", "all files listed in the final protocol match", not bad, mismatches=bad)
    man_ok = D.sha256(MANIFEST) == manifest_sha
    manifest = json.loads(MANIFEST.read_text())
    bad_m = [rel for rel, digest in manifest["files"].items() if not (REPO / rel).is_file() or D.sha256(REPO / rel) != digest]
    rep.add("P2c", "final package manifest and every listed file match", man_ok and not bad_m, manifest_sha_ok=man_ok, mismatches=bad_m)
    try:
        verify_calibration(cal_dir, freeze_sha)
        cal_ok = True
    except SystemExit as exc:
        cal_ok = False
        log(str(exc))
    rep.add("P2d", "calibration freeze and calibration artifacts match", cal_ok and freeze_sha == f2["calibration_freeze_sha256"])
    if pakistan_source:
        p = Path(pakistan_source)
        rep.add("P2e", "Pakistan source file bytes match (hash only, not parsed)",
                p.is_file() and D.sha256(p) == json.loads(PROTOCOL.read_text())["pakistan"]["source_sha256"])
    if not rep.ok:
        return rep, env          # never run computations on unverified files

    # P3 development frames (research copy R14 on CAL and SEL)
    table = CAL.us_table("2015-05-31")
    b = {}
    for h in C.HORIZONS:
        b[h] = xgb.Booster()
        b[h].load_model(str(OUT / "research_models" / f"R14_{h}.json"))
    frames = {}
    for name, (start, end) in {"CAL": ("2014-06-01", "2014-10-31"), "SEL": ("2014-11-01", "2015-05-31")}.items():
        rows, X, parity = C.serve(table, C.origins_every(start, end, 7), b)
        ref = pd.read_csv(OUT / "final_prep" / "dev_reference" / f"{name}.csv.gz", parse_dates=["origin"], float_precision="round_trip")
        d = _cmp_rows(rows, ref, tol["forecast_units_abs"])
        d["parity_vs_app_max_abs_units"] = parity
        rep.add("P3", f"development frame {name} reproduced (research copy R14)", _rows_ok(d) and parity < tol["parity_us_units"], **d)
        frames[name] = (rows, X)

    # P4 selected U2 prediction hashes
    u2 = CAL.selected_u2()
    sel, Xsel = frames["SEL"]
    for (h, p), booster in sorted(u2.items()):
        got = sha_bytes(U.predict(booster, U.features(sel, Xsel, h)))
        want = f2["development_prediction_sha256"]["selected_u2_sel"][f"{h}|{p}"]
        rep.add("P4", f"selected U2 h={h} p={p} SEL prediction hash equals development", got == want, got=got, expected=want)

    # P5 + P6 calibration rows and values (recomputed into a scratch folder, compared, then discarded)
    frozen_us = json.loads((cal_dir / "calibration_us.json").read_text())
    frozen_pk = json.loads((cal_dir / "calibration_pk.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        quiet = lambda m: None  # noqa: E731
        CAL.calibrate_us(tmp, quiet)
        CAL.calibrate_pk(tmp, quiet)
        new_us = json.loads((tmp / "calibration_us.json").read_text())
        new_pk = json.loads((tmp / "calibration_pk.json").read_text())
        for m in ("us", "pk"):
            rows = pd.read_csv(tmp / f"calibration_{m}_rows.csv.gz", parse_dates=["origin"], float_precision="round_trip")
            ref = pd.read_csv(cal_dir / f"calibration_{m}_rows.csv.gz", parse_dates=["origin"], float_precision="round_trip")
            d = _cmp_rows(rows, ref, tol["forecast_units_abs"])
            rep.add("P5", f"{m.upper()} calibration windows re-served by the frozen release match", _rows_ok(d), **d)
    par_ok = new_us["parity_max_abs_units"] < tol["parity_us_units"] and new_pk["parity_max_abs_units"] < tol["parity_pk_units"]
    rep.add("P5", "parity of the frozen release with ml/v2 forecast_totals", par_ok,
            us=new_us["parity_max_abs_units"], pk=new_pk["parity_max_abs_units"])
    for key in ("U0", "U1", "U2_correction", "D1_r"):
        missing, worst = _dict_diff(new_us[key], frozen_us[key])
        rep.add("P6", f"US calibration {key} within tolerance", not missing and worst <= tol["quantile_abs"],
                max_abs_diff=worst, tolerance=tol["quantile_abs"], missing=missing)
    rep.add("P6", "US calibration counts identical", new_us["counts"] == frozen_us["counts"])
    for key in ("U0", "U1"):
        missing, worst = _dict_diff(new_pk[key], frozen_pk[key])
        rep.add("P6", f"PK calibration {key} within tolerance", not missing and worst <= tol["quantile_abs"],
                max_abs_diff=worst, tolerance=tol["quantile_abs"], missing=missing)
    rep.add("P6", "PK calibration counts identical", new_pk["counts"] == frozen_pk["counts"])
    db = float(np.max(np.abs(np.array(new_pk["e1"]["beta"]) - np.array(frozen_pk["e1"]["beta"]))))
    same_meta = all(new_pk["e1"][k] == frozen_pk["e1"][k] for k in ("events", "alpha", "features", "fit_occurrences", "fit_rows"))
    rep.add("P6", "PK E1 beta within tolerance (same events, features, occurrences, rows)", same_meta and db <= tol["beta_abs"],
            max_abs_diff=db, tolerance=tol["beta_abs"])
    return rep, env


def write_report(rep, env, out, mode, extra=None):
    out.mkdir(parents=True, exist_ok=True)
    body = {"amendment": "nexus-stage3-final-protocol-v1-amendment-F2", "mode": mode, "passed": rep.ok,
            "environment": env, "checks": rep.checks, **(extra or {})}
    (out / "preflight_report.json").write_text(json.dumps(body, indent=2, default=str) + "\n")
    return body
