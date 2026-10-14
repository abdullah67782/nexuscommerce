"""Sequential inventory evaluation — entry point (protocol nexus-stage3-seq-protocol-v1).

    python seq_final.py preflight    --out DIR
    python seq_final.py execute-once --confirm PROTOCOL_SHA --lock-dir DIR --out DIR

preflight     development data only; no lock; reserved outcomes are not accessed:
                S1 environment equals the frozen one (Python 3.12, numpy 1.26.4, pandas 2.2.2, scipy 1.17.1,
                   xgboost 3.4.1) and Node.js is available;
                S2 the protocol and every file it lists match their hashes (code compared with LF line endings);
                S3 the reservation is intact: 150 products, none read before, the development loaders refuse them;
                S4 a development rehearsal (30 development products) serves forecasts with parity < 1e-3 against
                   ml/v2 forecast_totals and replays every policy;
                S5 engine parity: >= 2000 sampled rehearsal decisions recomputed by backend/lib/replenishment/
                   engine.js give EXACTLY the replay's quantities.
execute-once  runs the full preflight again (any failure stops before the lock), creates the one-time lock with
              O_CREAT|O_EXCL, reads the reserved products through seq_final_access, runs the frozen replay and gates,
              re-checks engine parity on the final run's own sampled decisions (G6), and writes results.json,
              REPORT.md, STATUS.json and a self-verified SHA256SUMS. An exception keeps the lock (.aborted) and the
              evidence; the run is never restarted.
Nothing here changes production. Under amendment F1 a passed cell authorises only an implementation review of
optional, seller-approved advice; promotion_authorised stays false in every result.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import numpy as np  # noqa: E402
import seq_protocol_spec as SPEC  # noqa: E402
import seq_data as SD  # noqa: E402
import seq_core as SC  # noqa: E402

D = SD.D
ENV = {"python_minor": "3.12", "numpy": "1.26.4", "pandas": "2.2.2", "scipy": "1.17.1", "xgboost": "3.4.1"}


class Log:
    def __init__(self, out):
        out.mkdir(parents=True, exist_ok=True)
        self.f = (out / "run.log").open("a", encoding="utf-8", newline="\n")

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


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def finalise(out, log, status, extra=None):
    """Last log line and STATUS.json first, then SHA256SUMS over every other file (LF line endings), self-verified."""
    log(f"finalising output: status={status}")
    log.close()
    write(out / "STATUS.json", json.dumps({"status": status, "finished_at": datetime.now(timezone.utc).isoformat(), **(extra or {})}, indent=2) + "\n")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name != "SHA256SUMS")
    write(out / "SHA256SUMS", "".join(f"{D.sha256(p)}  {p.relative_to(out).as_posix()}\n" for p in files))
    listed = dict(line.split("  ", 1)[::-1] for line in (out / "SHA256SUMS").read_text(encoding="utf-8").splitlines())
    if any(D.sha256(p) != listed[p.relative_to(out).as_posix()] for p in files):
        raise SystemExit("checksum self-verification failed")
    return D.sha256(out / "SHA256SUMS")


class Report:
    def __init__(self, log):
        self.checks, self.log = [], log

    def add(self, cid, name, ok, **detail):
        self.checks.append({"id": cid, "check": name, "pass": bool(ok), **detail})
        self.log(f"{'PASS' if ok else 'FAIL'} {cid} {name}" + (f" {json.dumps(detail, default=str)[:400]}" if detail and not ok else ""))
        return ok

    @property
    def ok(self):
        return all(c["pass"] for c in self.checks)


def node_parity(sample, workdir, log):
    path = workdir / "parity_sample.jsonl"
    write(path, "\n".join(json.dumps(s) for s in sample) + "\n")
    res = workdir / "parity_result.json"
    node = shutil.which("node")
    if not node:
        return {"exact": False, "error": "node not found"}
    p = subprocess.run([node, str(HERE / "engine_parity.js"), str(path), str(res)], capture_output=True, text=True)
    if not res.exists():
        return {"exact": False, "error": p.stderr[-500:]}
    return json.loads(res.read_text(encoding="utf-8"))


def sampler(n_max, seed):
    rng = np.random.default_rng(seed)
    sample = []

    def record(idx, t, L, R, stock, T7, T28, arrivals, SS, q, ok):
        if len(sample) >= n_max:
            return
        for j in rng.choice(len(idx), size=min(6, len(idx)), replace=False):
            if ok[j]:
                sample.append({"t": int(t), "L": int(L), "R": int(R), "on_hand": float(stock[j]), "t7": float(T7[j]), "t28": float(T28[j]),
                               "arrivals": {str(k + 1): float(arrivals[j, k]) for k in range(28) if arrivals[j, k] > 0},
                               "safety_stock": float(SS[j]), "quantity": float(q[j])})
    return sample, record


def preflight(out, log, protocol):
    import pandas as pd
    import scipy
    import xgboost as xgb
    rep = Report(log)
    env = {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "scipy": scipy.__version__,
           "xgboost": xgb.__version__, "platform": platform.platform(), "node": shutil.which("node")}
    rep.add("S1", "environment equals the frozen environment and Node.js is available",
            env["python"].startswith(ENV["python_minor"] + ".") and all(env[k] == ENV[k] for k in ("numpy", "pandas", "scipy", "xgboost")) and bool(env["node"]),
            environment=env, required=ENV)
    now = SPEC.hashes()
    bad = sorted(k for k, v in protocol["hashes"].items() if now.get(k) != v)
    rep.add("S2", "every file listed in the sequential protocol matches its hash", not bad, mismatches=bad)
    res = json.loads(D.RESERVATION.read_text())
    reserved = SD.seq_reserved()
    read_before = set(res["consumed_products"]) | set(res["development_extra_products"]) | set(res["holdout_products"])
    try:
        SD.guard(sorted(reserved)[:1])
        refused = False
    except D.FinalAccessSealed:
        refused = True
    rep.add("S3", "reservation intact (150 products, none read before, refused by the development loaders)",
            len(reserved) == 150 and not reserved & read_before and refused)
    products = sorted(res["consumed_products"] + res["development_extra_products"])[:30]
    table, excluded = SD.build_table(D.m5_daily(products, SD.DEV_REPLAY[1]), D.m5_launch_dates(products),
                                     SD.daily_prices(products, SD.DEV_REPLAY[1]), *SD.DEV_REPLAY)
    boosters, manifest = SC.C.production_boosters()
    sample, record = sampler(2400, protocol["seeds"]["parity_sample"])
    prep, results, meta = SC.run(table, SD.DEV_REPLAY[0], boosters, log, seed=protocol["seeds"]["replay"], record=record)
    rep.add("S4", "development rehearsal: parity with ml/v2 forecast_totals < 1e-3 and every policy replayed",
            meta["parity_max_abs_units"] < 1e-3 and all(results.get(k) for k in ["D0"] + [f"S{d}" for d in SC.RP.SELLER_DAYS]),
            parity_max_abs_units=meta["parity_max_abs_units"], series=len(table), release=manifest.get("release"))
    par = node_parity(sample, out, log)
    rep.add("S5", "engine parity: >= 2000 sampled decisions equal the application engine exactly",
            par.get("exact") is True and par.get("decisions", 0) >= 2000, decisions=par.get("decisions"), mismatches=par.get("mismatch_count"),
            error=par.get("error"))
    write(out / "preflight_report.json", json.dumps({"protocol_id": SPEC.PROTOCOL_ID, "protocol_sha256": D.sha256(SPEC.PROTOCOL),
                                                     "passed": rep.ok, "checks": rep.checks, "reserved_outcomes_accessed": False}, indent=1, default=str) + "\n")
    return rep


def report_md(results):
    lines = ["# Sequential inventory evaluation — FINAL (one time)", "",
             f"- Protocol `{results['protocol_sha256']}`; replay {results['replay'][0]} to {results['replay'][1]}; {results['series']} series",
             f"- Engine parity on the final run's decisions: {results['engine_parity_final'].get('equal')}/{results['engine_parity_final'].get('decisions')} exact",
             "- Under amendment F1 nothing here authorises promotion; a passed cell authorises only an implementation review of optional, seller-approved advice.",
             "", "| Cell | Series | Lost units D0 → candidate | Net benefit (30%, 25%) | G1 | G2 | G3 | G4 seller rule | G5 | G6 | Passed |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, c in results["cells"].items():
        if "gates" not in c:
            lines.append(f"| {name.replace('|', ' / ')} | {c.get('series', 0)} | — | — | | | | | | | False ({c.get('reason')}) |")
            continue
        g = c["gates"]
        t = c["totals"]
        lines.append(f"| {name.replace('|', ' / ')} | {c['series']} | {t['lost_D0']:.0f} → {t['lost_candidate']:.0f} | {c['net_benefit_primary']:.0f} | "
                     + " | ".join(str(g[k]) for k in ["G1_sample", "G2_shortage_reduction", "G3_net_benefit", "G4_better_than_seller_rule", "G5_kappa_robust", "G6_engine_parity"])
                     + f" | {c['passed']} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["preflight", "execute-once"])
    ap.add_argument("--confirm")
    ap.add_argument("--lock-dir")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    protocol = json.loads(SPEC.PROTOCOL.read_text(encoding="utf-8"))
    psha = D.sha256(SPEC.PROTOCOL)
    lock = None
    if a.mode == "execute-once":
        if not (a.confirm and a.lock_dir):
            raise SystemExit("execute-once needs --confirm and --lock-dir")
        if a.confirm != psha:
            raise SystemExit("--confirm must equal the sha256 of seq_protocol.json")
        if protocol.get("status") != "frozen":
            raise SystemExit("the protocol is a draft: the final run needs the frozen protocol")
        if out.exists() and any(out.iterdir()):
            raise SystemExit("output folder is not empty: the final run happens once")
        lock = Path(a.lock_dir) / "STAGE3_SEQUENTIAL_FINAL.lock"
        if lock.exists():
            raise SystemExit(f"lock exists ({lock}): the sequential final run has already been started once")
    log = Log(out)
    log(f"mode={a.mode} protocol={psha}")
    t0 = time.time()
    rep = preflight(out, log, protocol)
    log(f"preflight {'PASSED' if rep.ok else 'FAILED'} ({len(rep.checks)} checks) in {time.time() - t0:.0f}s")
    if not rep.ok:
        finalise(out, log, "PREFLIGHT_FAILED", {"reserved_outcomes_accessed": False, "lock_created": False})
        raise SystemExit("preflight failed: stopping before the lock; nothing reserved was read")
    if a.mode == "preflight":
        print(f"SHA256SUMS sha256 {finalise(out, log, 'PREFLIGHT_PASSED', {'reserved_outcomes_accessed': False, 'lock_created': False})}")
        return
    import seq_final_access as FA
    Path(a.lock_dir).mkdir(parents=True, exist_ok=True)
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, json.dumps({"protocol_sha256": psha, "started_at": datetime.now(timezone.utc).isoformat()}).encode())
    os.close(fd)
    gate = FA.SeqGate(FA.SeqGate._token, psha, str(lock))
    try:
        table, excluded = FA.final_table(gate)
        log(f"final series {len(table)}; excluded {excluded}")
        boosters, manifest = SC.C.production_boosters()
        sample, record = sampler(3000, protocol["seeds"]["parity_sample"] + 1)
        prep, res, meta = SC.run(table, FA.FINAL_REPLAY[0], boosters, log, seed=protocol["seeds"]["replay"], record=record)
        if meta["parity_max_abs_units"] >= 1e-3:
            raise RuntimeError("parity with the application failed in the final run")
        par = node_parity(sample, out, log)
        cells = SC.gates(prep, res, seed=protocol["seeds"]["gates"], parity_ok=par.get("exact") is True and par.get("decisions", 0) >= 2000)
        results = {"label": "SEQUENTIAL FINAL EVALUATION (one time)", "protocol_id": SPEC.PROTOCOL_ID, "protocol_sha256": psha,
                   "replay": list(FA.FINAL_REPLAY), "series": len(table), "excluded": excluded, "release": manifest.get("release"),
                   **meta, "engine_parity_final": {k: par.get(k) for k in ("decisions", "equal", "mismatch_count", "exact")},
                   "baselines": SC.baselines(prep, res), "cells": cells, "promotion_authorised": False,
                   "seconds": round(time.time() - t0, 1)}
        write(out / "results.json", json.dumps(results, indent=1, default=float) + "\n")
        write(out / "REPORT.md", report_md(results))
        for name, c in cells.items():
            log(f"{name}: passed={c.get('passed')} gates={c.get('gates')}")
    except BaseException as exc:          # the lock and the evidence are kept; never restarted
        write(out / "ABORTED_TRACEBACK.txt", traceback.format_exc())
        sums = finalise(out, log, "ABORTED", {"error": repr(exc), "reserved_outcomes_accessed": True, "lock_created": True})
        Path(str(lock) + ".aborted").write_text(json.dumps({"sha256sums": sums, "error": repr(exc)}) + "\n")
        raise
    sums = finalise(out, log, "COMPLETED", {"reserved_outcomes_accessed": True, "lock_created": True})
    Path(str(lock) + ".completed").write_text(json.dumps({"sha256sums": sums, "finished_at": datetime.now(timezone.utc).isoformat()}) + "\n")
    print(f"SHA256SUMS sha256 {sums}")


if __name__ == "__main__":
    main()
