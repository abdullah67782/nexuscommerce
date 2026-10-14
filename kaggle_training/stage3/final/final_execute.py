"""Stage 3 final evaluation — package entry point (protocol v1 + amendments F1 and F2).

    python final_execute.py preflight    --manifest-sha SHA --calibration DIR --calibration-freeze-sha SHA
                                         [--pakistan-source CSV] --out DIR
    python final_execute.py execute-once --confirm PROTOCOL_SHA --manifest-sha SHA --calibration DIR
                                         --calibration-freeze-sha SHA --pakistan-source CSV --lock-dir DIR --out DIR
    python final_execute.py rehearse     (same arguments as preflight; development stand-ins, no reserved data)

preflight     amendment F2 checks only. Development data only; no lock; reserved outcomes are not accessed.
execute-once  runs the full preflight again; on any failure it stops before the lock. Then it creates the one-time
              lock (O_CREAT|O_EXCL), opens the reserved data through final_access, and runs the frozen protocol-v1
              evaluation (final_runner.run_us / run_pk, unchanged). Results are labelled per amendment F1:
              decision protection is research-only and its development-relative excess cap is a stability check.
Nothing here retrains, recalibrates or substitutes an artifact, and nothing changes production.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import final_access as FA  # noqa: E402
import final_runner as R  # noqa: E402
import preflight as P  # noqa: E402

D = C.D


class Log:
    def __init__(self, out):
        out.mkdir(parents=True, exist_ok=True)
        self.f = (out / "run.log").open("a", encoding="utf-8")

    def __call__(self, msg):
        line = f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
        print(line, flush=True)
        if self.f:
            self.f.write(line + "\n")
            self.f.flush()

    def close(self):
        if self.f:
            self.f.close()
            self.f = None


def finalise(out, log, status, extra=None):
    """Output finalisation: the last log line and the status record are written FIRST, the log is closed, and only
    then SHA256SUMS is computed over every other file. Nothing is written into `out` afterwards."""
    log(f"finalising output: status={status}")
    log.close()
    (out / "STATUS.json").write_text(json.dumps({"status": status, "finished_at": datetime.now(timezone.utc).isoformat(),
                                                 **(extra or {})}, indent=2) + "\n")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "SHA256SUMS")
    (out / "SHA256SUMS").write_text("".join(f"{D.sha256(p)}  {p.relative_to(out).as_posix()}\n" for p in files))
    bad = [p for p in files if D.sha256(p) != dict(l.split("  ", 1)[::-1] for l in (out / "SHA256SUMS").read_text().splitlines())[p.relative_to(out).as_posix()]]
    if bad:
        raise SystemExit(f"checksum self-verification failed: {bad}")
    return D.sha256(out / "SHA256SUMS")


def relabel(results, f1):
    """Amendment F1: decision protection is research-only; the excess cap is a research stability check."""
    for rule, gates in results["us"]["decision_gates"].items():
        for key, g in gates.items():
            if "excess_per_avoided_le_cap_every_cell" in g:
                g["research_stability_check_excess_cap"] = g.pop("excess_per_avoided_le_cap_every_cell")
            g["research_checks_all_met"] = g.pop("pass")
            g["promotion_authorised"] = False
            g["status"] = f1["status_label"]
    return results


def summary(results):
    us, pk = results["us"], results["pakistan"]
    return {
        "label": results["label"],
        "promotion_gates": {
            "e1c_us_pass": us["e1c_gates"]["pass"],
            "totals_uncertainty_cells_pass": {k: v["pass"] for k, v in us["totals_gates"].items()},
            "pakistan_e1_pass": pk["e1_gates"]["pass"],
        },
        "research_only_amendment_F1": {
            "decision_protection_A2": {k: {"research_checks_all_met": v["research_checks_all_met"],
                                           "research_stability_check_excess_cap": v.get("research_stability_check_excess_cap"),
                                           "promotion_authorised": False}
                                       for k, v in us["decision_gates"]["A2_kappa_robust"].items()},
            "pakistan_uncertainty": "descriptive only",
        },
        "scope": "a passed promotion gate authorises only an implementation review for that market, segment, horizon and level; production is unchanged",
    }


def report_md(results, pre, out):
    s = summary(results)
    lines = [f"# Stage 3 final evaluation — {results['label']}", "",
             f"- Protocol v1 `{results['protocol_sha256']}`; manifest `{results['manifest_sha256']}`; calibration freeze `{results['calibration_freeze_sha256']}`",
             f"- Preflight (amendment F2): {'passed' if pre['passed'] else 'FAILED'} ({len(pre['checks'])} checks)",
             f"- Environment: {results['environment']}", "",
             "## Promotion gates (protocol v1)", "", "| Capability | Pass |", "|---|---|",
             f"| US event layer E1c | {s['promotion_gates']['e1c_us_pass']} |",
             f"| Pakistan E1 (Independence Day, Eid al-Adha) | {s['promotion_gates']['pakistan_e1_pass']} |"]
    for k, v in s["promotion_gates"]["totals_uncertainty_cells_pass"].items():
        lines.append(f"| US totals uncertainty {k.replace('|', ' / ')} | {v} |")
    lines += ["", "## Decision protection — research only (amendment F1; never authorises promotion)", "",
              "| Segment, level | Research checks all met | Excess-cap stability check |", "|---|---|---|"]
    for k, v in s["research_only_amendment_F1"]["decision_protection_A2"].items():
        cap = v["research_stability_check_excess_cap"]
        lines.append(f"| {k.replace('|', ' / ')} | {v['research_checks_all_met']} | {'n/a (no selection)' if cap is None else cap} |")
    lines += ["", "Full numbers: `results.json`. Production models, routing and replenishment-1 are unchanged."]
    (out / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "gates_summary.json").write_text(json.dumps(s, indent=2) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["preflight", "execute-once", "rehearse"])
    ap.add_argument("--confirm")
    ap.add_argument("--manifest-sha", required=True)
    ap.add_argument("--calibration", required=True)
    ap.add_argument("--calibration-freeze-sha", required=True)
    ap.add_argument("--pakistan-source")
    ap.add_argument("--lock-dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--reference-unpinned", action="store_true", help="development-machine reference run only; never valid for execute-once")
    a = ap.parse_args()
    out = Path(a.out)
    if a.mode == "execute-once":
        if a.reference_unpinned:
            raise SystemExit("--reference-unpinned is not allowed for execute-once")
        if not (a.confirm and a.pakistan_source and a.lock_dir):
            raise SystemExit("execute-once needs --confirm, --pakistan-source and --lock-dir")
        if a.confirm != D.sha256(R.PROTOCOL):
            raise SystemExit("--confirm must equal the sha256 of final_protocol.json")
        if out.exists() and any(out.iterdir()):
            raise SystemExit("output folder is not empty: the final evaluation runs once")
        lock = Path(a.lock_dir) / "STAGE3_FINAL_EVALUATION.lock"
        if lock.exists():
            raise SystemExit(f"lock exists ({lock}): the final evaluation has already been started once")
    t0 = time.time()
    log = Log(out)
    log(f"mode={a.mode}")
    rep, env = P.run(a.calibration, a.calibration_freeze_sha, a.manifest_sha,
                     pakistan_source=a.pakistan_source if a.mode == "execute-once" or a.pakistan_source else None,
                     allow_unpinned=a.reference_unpinned, log=log)
    pre = P.write_report(rep, env, out / "preflight", a.mode,
                         {"manifest_sha256": a.manifest_sha, "calibration_freeze_sha256": a.calibration_freeze_sha,
                          "protocol_sha256": D.sha256(R.PROTOCOL), "reference_unpinned": a.reference_unpinned,
                          "reserved_outcomes_accessed": False, "seconds": round(time.time() - t0, 1)})
    log(f"preflight {'PASSED' if rep.ok else 'FAILED'} ({len(rep.checks)} checks) in {time.time() - t0:.0f}s")
    if not rep.ok:
        finalise(out, log, "PREFLIGHT_FAILED", {"reserved_outcomes_accessed": False, "lock_created": False})
        raise SystemExit("preflight failed: stopping before any reserved outcome is accessed; nothing is retrained or substituted")
    if a.mode == "preflight":
        sums = finalise(out, log, "PREFLIGHT_PASSED", {"reserved_outcomes_accessed": False, "lock_created": False})
        print(f"SHA256SUMS sha256 {sums}")
        return

    protocol = json.loads(R.PROTOCOL.read_text())
    f1 = json.loads(P.F1.read_text())
    gate = None
    if a.mode == "execute-once":
        Path(a.lock_dir).mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise SystemExit("lock exists: the final evaluation has already been started once")
        os.write(fd, json.dumps({"protocol_sha256": D.sha256(R.PROTOCOL), "manifest_sha256": a.manifest_sha,
                                 "started_at": datetime.now(timezone.utc).isoformat()}).encode())
        os.close(fd)
        gate = FA.FinalGate(FA.FinalGate._token, D.sha256(R.PROTOCOL), str(lock))
        run_mode = "final"
    else:
        run_mode = "rehearse"
    cal_dir = Path(a.calibration)
    calib_us = json.loads((cal_dir / "calibration_us.json").read_text())
    calib_pk = json.loads((cal_dir / "calibration_pk.json").read_text())
    from calibrate import selected_u2
    import numpy as np
    import pandas as pd
    import xgboost as xgb
    results = {"label": "FINAL EVALUATION (one time)" if run_mode == "final" else "REHEARSAL on development data: not evidence",
               "protocol_id": protocol["protocol_id"], "protocol_sha256": D.sha256(R.PROTOCOL),
               "amendments": {"F1": D.sha256(P.F1), "F2": D.sha256(P.F2)}, "manifest_sha256": a.manifest_sha,
               "calibration_freeze_sha256": a.calibration_freeze_sha, "started_at": datetime.now(timezone.utc).isoformat(),
               "environment": {"numpy": np.__version__, "pandas": pd.__version__, "xgboost": xgb.__version__}}
    try:
        results["us"] = R.run_us(run_mode, protocol, calib_us, selected_u2(), gate, out, log)
        results["pakistan"] = R.run_pk(run_mode, protocol, calib_pk, gate, out, log, a.pakistan_source)
    except BaseException as exc:        # an interrupted one-time run keeps its evidence and its lock; it is never retried
        import traceback
        (out / "ABORTED_TRACEBACK.txt").write_text(traceback.format_exc())
        sums = finalise(out, log, "ABORTED", {"error": repr(exc), "reserved_outcomes_accessed": run_mode == "final"})
        if gate is not None:
            Path(str(lock) + ".aborted").write_text(json.dumps({"sha256sums": sums, "error": repr(exc)}) + "\n")
        raise
    results = relabel(results, f1)
    results["seconds"] = round(time.time() - t0, 1)
    results["production_unchanged"] = protocol["production_unchanged"]
    (out / "results.json").write_text(json.dumps(results, indent=2, default=str) + "\n")
    report_md(results, pre, out)
    log(f"{run_mode} evaluation finished in {results['seconds']} s")
    sums = finalise(out, log, "COMPLETED", {"mode": run_mode, "reserved_outcomes_accessed": run_mode == "final"})
    if gate is not None:
        Path(str(lock) + ".completed").write_text(json.dumps({"sha256sums": sums,
                                                              "finished_at": datetime.now(timezone.utc).isoformat()}) + "\n")
    print(f"SHA256SUMS sha256 {sums}")


if __name__ == "__main__":
    main()
