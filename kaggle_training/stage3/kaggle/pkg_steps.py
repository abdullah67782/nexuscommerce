"""Stage 3 training / calibration package steps (development data only; no reserved outcome is read).

    python pkg_steps.py env        # versions, GPU detection
    python pkg_steps.py verify     # frozen protocol + every listed hash (code, models, data, selections)
    python pkg_steps.py reproduce  # rebuild development frames with the research copies; compare with development
    python pkg_steps.py u2_cpu     # retrain U2 on CPU (development recipe); compare with the SELECTED boosters
    python pkg_steps.py u2_gpu     # GPU diagnostic retrain (never selected); skipped without a GPU
    python pkg_steps.py calibrate  # final calibration (US + PK) with the frozen release and the selected U2 boosters
    python pkg_steps.py package    # report, manifest, SHA256SUMS and the output ZIP

Each step writes WORK/state/<step>.done and refuses to run before the previous step is done.
WORK defaults to <repo>/stage3_run (override with NEXUS_WORK).
"""
import json
import os
import pickle
import platform
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE3 = HERE.parent
REPO = STAGE3.parents[1]
sys.path.insert(0, str(STAGE3 / "final"))
sys.path.insert(0, str(STAGE3))

WORK = Path(os.environ.get("NEXUS_WORK", REPO / "stage3_run"))
STATE, LOGS, ART = WORK / "state", WORK / "logs", WORK / "artifacts"
ORDER = ["env", "verify", "reproduce", "u2_cpu", "u2_gpu", "calibrate", "package"]
ZIP_NAME = "nexus_stage3_training_calibration_output.zip"


def log_to(step):
    LOGS.mkdir(parents=True, exist_ok=True)
    f = (LOGS / f"{step}.log").open("a")

    def log(msg):
        line = f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, flush=True)
        f.write(line + "\n")
        f.flush()
    return log


def require(step):
    i = ORDER.index(step)
    for prev in ORDER[:i]:
        if not (STATE / f"{prev}.done").exists():
            raise SystemExit(f"run step '{prev}' first")


def done(step, info):
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / f"{step}.done").write_text(json.dumps({"finished_at": datetime.now(timezone.utc).isoformat(), **info}, indent=2, default=str))


# ----------------------------------------------------------------------------- steps
def step_env(log):
    import numpy as np
    import pandas as pd
    import scipy
    import xgboost as xgb
    info = {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scipy": scipy.__version__,
            "xgboost": xgb.__version__, "platform": platform.platform(), "cpu_count": os.cpu_count()}
    try:
        smi = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=30)
        info["gpu"] = smi.stdout.strip() or None
    except Exception:
        info["gpu"] = None
    info["xgboost_cuda_build"] = bool(xgb.build_info().get("USE_CUDA"))
    pins = json.loads((HERE / "pins.json").read_text())
    info["pins_ok"] = {k: info.get(k) == v for k, v in pins["required"].items()}
    info["unpinned_override"] = os.environ.get("NEXUS_ALLOW_UNPINNED") == "1"
    for k, v in info.items():
        log(f"{k}: {v}")
    if not all(info["pins_ok"].values()) and os.environ.get("NEXUS_ALLOW_UNPINNED") != "1":
        raise SystemExit(f"package versions differ from the app pins: {info['pins_ok']}")
    (WORK / "env.json").write_text(json.dumps(info, indent=2))
    return info


def step_verify(log):
    import data_access as D
    from final_runner import PROTOCOL, PROTOCOL_SHA, verify_hashes
    protocol = json.loads(PROTOCOL.read_text())
    sha = D.sha256(PROTOCOL)
    if PROTOCOL_SHA.read_text().split()[0] != sha:
        raise SystemExit("final_protocol.json does not match final_protocol.sha256")
    bad = verify_hashes(protocol, REPO)
    if bad:
        raise SystemExit(f"hash mismatch: {bad}")
    ref = json.loads((STAGE3 / "outputs" / "final_prep" / "dev_reference" / "index.json").read_text())
    for name, digest in ref["files"].items():
        if D.sha256(STAGE3 / "outputs" / "final_prep" / "dev_reference" / name) != digest:
            raise SystemExit(f"development reference {name} changed")
    log(f"protocol {protocol['protocol_id']} sha256 {sha}: verified")
    log(f"{len(protocol['hashes'])} frozen files verified; reserved outcomes are not read by this package")
    return {"protocol_sha256": sha, "files_verified": len(protocol["hashes"])}


def _frames():
    return pickle.loads((WORK / "cache" / "dev_frames.pkl").read_bytes())


def step_reproduce(log):
    import numpy as np
    import pandas as pd
    import common as C
    from calibrate import us_table
    import xgboost as xgb
    refdir = STAGE3 / "outputs" / "final_prep" / "dev_reference"
    table = us_table("2015-05-31")
    log(f"development series rebuilt: {len(table)}")
    periods = {"FIT_A": ("R12", "2012-06-01", "2013-05-31"), "FIT_B": ("R13", "2013-06-01", "2014-05-31"),
               "CAL": ("R14", "2014-06-01", "2014-10-31"), "SEL": ("R14", "2014-11-01", "2015-05-31")}
    frames, report = {}, {}
    for name, (model, start, end) in periods.items():
        b = {}
        for h in C.HORIZONS:
            b[h] = xgb.Booster()
            b[h].load_model(str(STAGE3 / "outputs" / "research_models" / f"{model}_{h}.json"))
        rows, X, parity = C.serve(table, C.origins_every(start, end, 7), b)
        ref = pd.read_csv(refdir / f"{name}.csv.gz", parse_dates=["origin"], float_precision="round_trip")
        m = rows.merge(ref, on=["series_key", "h", "origin"], how="outer", suffixes=("", "_dev"), indicator=True)
        both = m["_merge"] == "both"
        dF = (m.loc[both, "F"] - m.loc[both, "F_dev"]).abs()
        rec = {"model": model, "rows": int(len(rows)), "rows_dev": int(len(ref)), "rows_only_here": int((m["_merge"] == "left_only").sum()),
               "rows_only_dev": int((m["_merge"] == "right_only").sum()), "parity_vs_app_max_abs_units": parity,
               "F_max_abs_diff_vs_dev": float(dF.max()) if len(dF) else None, "F_rows_diff_gt_1e-9": int((dF > 1e-9).sum()),
               "F_rows_diff_gt_1e-3": int((dF > 1e-3).sum()),
               "A_identical": bool((m.loc[both, "A"] == m.loc[both, "A_dev"]).all()),
               "group_identical": bool((m.loc[both, "group"] == m.loc[both, "group_dev"]).all()),
               "method_identical": bool((m.loc[both, "method"] == m.loc[both, "method_dev"]).all())}
        rec["reproduces_development"] = (rec["rows_only_here"] == 0 and rec["rows_only_dev"] == 0 and rec["A_identical"]
                                         and rec["group_identical"] and rec["method_identical"] and (rec["F_max_abs_diff_vs_dev"] or 0) < 1e-3
                                         and parity < 1e-3)
        log(f"{name}: rows {rec['rows']} (dev {rec['rows_dev']}), parity vs app {parity:.2e}, max |F - dev F| {rec['F_max_abs_diff_vs_dev']:.2e}, "
            f"rows differing > 1e-9: {rec['F_rows_diff_gt_1e-9']}, reproduces development: {rec['reproduces_development']}")
        report[name] = rec
        frames[name] = (rows, X)
    (WORK / "cache").mkdir(parents=True, exist_ok=True)
    (WORK / "cache" / "dev_frames.pkl").write_bytes(pickle.dumps(frames))
    (ART / "checks").mkdir(parents=True, exist_ok=True)
    (ART / "checks" / "reproduce_development.json").write_text(json.dumps(report, indent=2))
    if not all(r["reproduces_development"] for r in report.values()):
        raise SystemExit("development frames were not reproduced within the frozen tolerance; see checks/reproduce_development.json")
    return {"periods": {k: v["reproduces_development"] for k, v in report.items()}}


def _u2_compare(device, log):
    import numpy as np
    import xgboost as xgb
    import u2_artifacts as U
    from calibrate import selected_u2
    frames = _frames()
    fit_parts = [frames["FIT_A"], frames["FIT_B"]]
    cal, Xcal = frames["CAL"]
    sel, Xsel = frames["SEL"]
    import pandas as pd
    sel_ref = pd.read_csv(STAGE3 / "outputs" / "final_prep" / "dev_reference" / "SEL_U2_uppers.csv.gz", parse_dates=["origin"], float_precision="round_trip")
    chosen = selected_u2()
    selections = json.loads((STAGE3 / "outputs" / "us" / "uncertainty_selection.json").read_text())
    out_dir = ART / ("u2_kaggle_cpu_reproduction" if device == "cpu" else "u2_gpu_diagnostic_NOT_SELECTED")
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {"device": device, "selected_artifacts_unchanged": True, "models": {}}
    for p in U.LEVELS:
        for h in U.HORIZONS:
            t0 = time.time()
            b = U.train(fit_parts, h, p, device=device)
            secs = round(time.time() - t0, 1)
            f_sel = U.features(sel, Xsel, h)
            pred_new, pred_sel = U.predict(b, f_sel), U.predict(chosen[(h, p)], f_sel)
            corr_new = U.corrections(b, cal, Xcal, h, p)
            corr_sel = U.corrections(chosen[(h, p)], cal, Xcal, h, p)
            up_new = U.uppers(b, corr_new, sel, Xsel, h)
            up_sel = U.uppers(chosen[(h, p)], corr_sel, sel, Xsel, h)
            r = sel.loc[sel.h == h]
            ref = r[["series_key", "origin"]].merge(sel_ref.loc[sel_ref.h == h], on=["series_key", "origin"], how="left")[f"u2_p{p}"].to_numpy()
            if np.isnan(ref).any():
                raise SystemExit("development U2 reference rows do not match the reproduced SEL rows")
            cells = {}
            for seg in U.SEGMENTS:
                key = f"{seg}|{h}|{p}"
                if selections.get(key, {}).get("method") != "U2":
                    continue
                msk = (r.group == seg).to_numpy()
                A = r.A.to_numpy()[msk]
                cells[key] = {"hits_selected_booster": int((A <= up_sel[msk]).sum()), "hits_this_retrain": int((A <= up_new[msk]).sum()),
                              "hits_development": int((A <= ref[msk]).sum()), "windows": int(msk.sum())}
            name = f"U2_h{h}_p{p}_{device}.json"
            b.save_model(str(out_dir / name))
            rec = {"file": name, "train_seconds": secs,
                   "max_abs_pred_diff_vs_selected": float(np.max(np.abs(pred_new - pred_sel))),
                   "max_abs_upper_diff_vs_selected": float(np.max(np.abs(up_new - up_sel))),
                   "selected_booster_upper_max_abs_diff_vs_development": float(np.max(np.abs(up_sel - ref))),
                   "identical_to_selected": bool(np.array_equal(pred_new, pred_sel)), "selected_cells": cells}
            report["models"][f"{h}|{p}"] = rec
            log(f"{device} U2 h={h} p={p}: {secs}s, max |pred - selected| {rec['max_abs_pred_diff_vs_selected']:.3e}, "
                f"selected-booster SEL upper vs development {rec['selected_booster_upper_max_abs_diff_vs_development']:.3e}")
    (ART / "checks").mkdir(parents=True, exist_ok=True)
    (ART / "checks" / f"u2_{device}_comparison.json").write_text(json.dumps(report, indent=2))
    return report


def step_u2_cpu(log):
    rep = _u2_compare("cpu", log)
    return {"identical_to_selected": all(m["identical_to_selected"] for m in rep["models"].values())}


def step_u2_gpu(log):
    env = json.loads((WORK / "env.json").read_text())
    if not env.get("gpu") or not env.get("xgboost_cuda_build"):
        log("no GPU (or xgboost without CUDA): GPU diagnostic skipped; CPU results are complete")
        (ART / "checks").mkdir(parents=True, exist_ok=True)
        (ART / "checks" / "u2_cuda_comparison.json").write_text(json.dumps({"skipped": "no GPU available"}, indent=2))
        return {"skipped": True}
    try:
        rep = _u2_compare("cuda", log)
    except Exception as exc:          # GPU failure never blocks the CPU path
        log(f"GPU diagnostic failed: {exc!r}; CPU results are unaffected")
        (ART / "checks" / "u2_cuda_comparison.json").write_text(json.dumps({"failed": repr(exc)}, indent=2))
        return {"failed": repr(exc)}
    log("GPU boosters are diagnostics only; the selected CPU boosters are unchanged and are the ones used for calibration")
    return {"identical_to_selected": all(m["identical_to_selected"] for m in rep["models"].values())}


def step_calibrate(log):
    import calibrate as CAL
    out = ART / "calibration"
    out.mkdir(parents=True, exist_ok=True)
    us = CAL.calibrate_us(out, log)
    pk = CAL.calibrate_pk(out, log)
    return {"us_windows": us["windows"], "pk_windows": pk["windows"]}


def step_package(log):
    import data_access as D
    protocol_sha = (STAGE3 / "outputs" / "final_protocol.sha256").read_text().split()[0]
    states = {s: json.loads((STATE / f"{s}.done").read_text()) for s in ORDER[:-1]}
    env = json.loads((WORK / "env.json").read_text())
    rep = json.loads((ART / "checks" / "reproduce_development.json").read_text())
    cpu = json.loads((ART / "checks" / "u2_cpu_comparison.json").read_text())
    gpu = json.loads((ART / "checks" / "u2_cuda_comparison.json").read_text())
    lines = ["# Stage 3 training / calibration run", "",
             f"- Protocol: `nexus-stage3-final-protocol-v1`, sha256 `{protocol_sha}`",
             f"- Environment: Python {env['python']}, numpy {env['numpy']}, pandas {env['pandas']}, xgboost {env['xgboost']}; GPU: {env.get('gpu') or 'none'}",
             "- Reserved outcomes: not read (guarded development loaders only).", "",
             "## Development reproduction (research copies)", "", "| Period | Rows | Parity vs app | max abs F diff vs development | Reproduces |", "|---|---|---|---|---|"]
    for k, v in rep.items():
        lines.append(f"| {k} | {v['rows']} | {v['parity_vs_app_max_abs_units']:.2e} | {v['F_max_abs_diff_vs_dev']:.2e} | {v['reproduces_development']} |")
    lines += ["", "## U2 boosters (selected artifacts are the development CPU boosters; never replaced)", "",
              "| h, p | CPU retrain identical to selected | CPU max abs pred diff | GPU max abs pred diff (diagnostic) |", "|---|---|---|---|"]
    for key, v in cpu["models"].items():
        g = gpu.get("models", {}).get(key)
        hk, pk = key.split("|")
        lines.append(f"| h={hk}, p={pk} | {v['identical_to_selected']} | {v['max_abs_pred_diff_vs_selected']:.2e} | "
                     f"{'skipped' if g is None else format(g['max_abs_pred_diff_vs_selected'], '.2e')} |")
    lines += ["", "## Calibration artifacts", ""]
    for f in sorted((ART / "calibration").iterdir()):
        lines.append(f"- `{f.name}` sha256 `{D.sha256(f)}`")
    (ART / "REPORT.md").write_text("\n".join(lines) + "\n")
    shutil.copytree(LOGS, ART / "logs", dirs_exist_ok=True)
    shutil.copytree(STAGE3 / "outputs" / "u2_selected", ART / "u2_selected_UNCHANGED", dirs_exist_ok=True)
    (ART / "protocol").mkdir(exist_ok=True)
    for name in ("final_protocol.json", "final_protocol.sha256", "dev_protocol_amendment_A2.json"):
        shutil.copy(STAGE3 / "outputs" / name, ART / "protocol" / name)
    shutil.copy(WORK / "env.json", ART / "env.json")
    (ART / "state").mkdir(exist_ok=True)
    for s in ORDER[:-1]:
        shutil.copy(STATE / f"{s}.done", ART / "state" / f"{s}.done.json")
    manifest = {"package": "nexus-stage3-training-calibration-v1", "protocol_sha256": protocol_sha, "steps": states,
                "created_at": datetime.now(timezone.utc).isoformat(), "reserved_outcomes_read": False}
    (ART / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    sums = []
    for f in sorted(ART.rglob("*")):
        if f.is_file() and f.name != "SHA256SUMS":
            sums.append(f"{D.sha256(f)}  {f.relative_to(ART).as_posix()}")
    (ART / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    zpath = WORK / ZIP_NAME
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(ART.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(ART).as_posix())
    log(f"output ZIP: {zpath} ({zpath.stat().st_size / 1e6:.1f} MB), sha256 {D.sha256(zpath)}")
    return {"zip": str(zpath), "zip_sha256": D.sha256(zpath)}


STEPS = {"env": step_env, "verify": step_verify, "reproduce": step_reproduce, "u2_cpu": step_u2_cpu, "u2_gpu": step_u2_gpu,
         "calibrate": step_calibrate, "package": step_package}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in STEPS:
        raise SystemExit(__doc__)
    step = sys.argv[1]
    WORK.mkdir(parents=True, exist_ok=True)
    require(step)
    if (STATE / f"{step}.done").exists() and step in ("calibrate", "package"):
        raise SystemExit(f"step '{step}' already completed in this run folder; start a new run folder to repeat it")
    log = log_to(step)
    t0 = time.time()
    log(f"step {step} started")
    info = STEPS[step](log)
    done(step, {"seconds": round(time.time() - t0, 1), **(info or {})})
    log(f"step {step} finished in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
