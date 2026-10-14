"""Stage 3 ONE-TIME final evaluation runner (frozen with protocol nexus-stage3-final-protocol-v1).

Modes
  --rehearse      Development stand-ins only, through the guarded development loaders:
                  US: development-extra products, windows inside 2014-11-01..2015-05-31;
                  PK: development extract, windows inside 2017-07-01..2017-12-31.
                  Exercises every code path and gate. Results are labelled REHEARSAL and are not evidence.
  --execute-once  The final evaluation. Requires --confirm <sha256 of final_protocol.json>, a verified
                  calibration freeze (--calibration-freeze-sha), the Pakistan source file, and a lock folder.
                  Refuses if the lock exists, if the output folder is not empty, or if any hash differs.

Nothing in this file changes production models, routing or replenishment-1.
"""
import argparse
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import final_access as FA  # noqa: E402

D, E = C.D, C.E
PROTOCOL = C.STAGE3 / "outputs" / "final_protocol.json"
PROTOCOL_SHA = C.STAGE3 / "outputs" / "final_protocol.sha256"
UNCAT = "\\N"


# ----------------------------------------------------------------------------- verification
def verify_hashes(protocol, root):
    bad = []
    for rel, digest in protocol["hashes"].items():
        path = root / rel
        if not path.is_file() or D.sha256(path) != digest:
            bad.append(rel)
    return bad


def verify_calibration(cal_dir, freeze_sha):
    freeze_path = cal_dir / "calibration_freeze.json"
    if D.sha256(freeze_path) != freeze_sha:
        raise SystemExit("calibration_freeze.json does not match the hash given on the command line")
    freeze = json.loads(freeze_path.read_text())
    for name, digest in freeze["artifacts"].items():
        if D.sha256(cal_dir / name) != digest:
            raise SystemExit(f"calibration artifact {name} differs from the frozen calibration")
    return freeze


# ----------------------------------------------------------------------------- data
def us_table_from_long(long, launches):
    long = long.merge(launches, on=["store_id", "item_id"], how="inner")
    long = long.loc[long.date >= long.launch_date]
    table = {}
    for (store, item), g in long.groupby(["store_id", "item_id"], sort=True):
        g = g.sort_values("date")
        if not g.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError(f"gap in {store} {item}")
        table[(store, item)] = {"start": g.date.iloc[0], "values": g.sales.to_numpy(dtype=float), "cat": g.cat_id.iloc[0]}
    return table


def pk_table_from_df(df, start, end):
    df = df.copy()
    df["category"] = df.category.fillna(UNCAT).astype(str)
    days = pd.date_range(start, end)
    daily = df.groupby(["category", "sale_date"]).quantity.sum().unstack(0).reindex(days).fillna(0.0)
    return {c: {"start": days[0], "values": daily[c].to_numpy(dtype=float), "cat": c} for c in daily.columns}


def pk_calendar(protocol):
    rows = list(E.PK_EVENTS) + [tuple(x) for x in protocol["pakistan"]["final_event_dates"]]
    return pd.DataFrame([(e, pd.Timestamp(d), bool(l)) for e, d, l in rows], columns=["event", "date", "lunar"]).drop_duplicates()


# ----------------------------------------------------------------------------- US evaluation
def event_layer_us(rows, calendar, rng, start, log):
    Fadj = C.apply_e1c(rows, calendar)
    A, F, ev = rows.A.to_numpy(), rows.F.to_numpy(), rows.event.to_numpy()
    blocks = C.date_blocks(rows.origin, start)
    prods = rows.item_id.to_numpy()
    res, gates = {}, {}
    for h in C.HORIZONS:
        m = (rows.h == h).to_numpy()
        e_, n_ = m & ev, m & ~ev
        rec = {"windows": int(m.sum()), "event_windows": int(e_.sum()),
               "wape_all_base": C.wape(F[m], A[m]), "wape_all_e1c": C.wape(Fadj[m], A[m]),
               "wape_event_base": C.wape(F[e_], A[e_]), "wape_event_e1c": C.wape(Fadj[e_], A[e_]),
               "wape_non_event_base": C.wape(F[n_], A[n_]), "wape_non_event_e1c": C.wape(Fadj[n_], A[n_]),
               "bias_event_base": C.bias(F[e_], A[e_]), "bias_event_e1c": C.bias(Fadj[e_], A[e_])}
        rec["rel_event_improvement"] = (rec["wape_event_base"] - rec["wape_event_e1c"]) / rec["wape_event_base"]
        idx = np.flatnonzero(e_)

        def stat(ix, idx=idx):
            sub = idx[ix]
            w0 = np.abs(F[sub] - A[sub]).sum()
            return (w0 - np.abs(Fadj[sub] - A[sub]).sum()) / w0 if w0 else None
        rec["date_block_95"] = C.bootstrap_ci(stat, blocks[idx], rng)
        rec["product_cluster_95"] = C.bootstrap_ci(stat, prods[idx], rng)
        res[str(h)] = rec
    g = {"event_improvement_ge_5pct_both_horizons": all(res[str(h)]["rel_event_improvement"] >= 0.05 for h in C.HORIZONS),
         "overall_and_non_event_no_worse_than_plus_0_5_points": all(
             res[str(h)]["wape_all_e1c"] <= res[str(h)]["wape_all_base"] + 0.5 and
             res[str(h)]["wape_non_event_e1c"] <= res[str(h)]["wape_non_event_base"] + 0.5 for h in C.HORIZONS),
         "event_bias_not_larger": all(abs(res[str(h)]["bias_event_e1c"]) <= abs(res[str(h)]["bias_event_base"]) for h in C.HORIZONS),
         "intervals_exclude_zero": all(res[str(h)][k][0] is not None and res[str(h)][k][0] > 0
                                       for h in C.HORIZONS for k in ("date_block_95", "product_cluster_95"))}
    g["pass"] = all(g.values())
    log(f"E1c gates evaluated: pass={g['pass']}")
    return res, g


def totals_us(rows, X, table, calib, u2, protocol, start, log):
    rng = np.random.default_rng(protocol["seeds"]["u3"])
    up = C.totals_uppers(rows, X, table, calib, u2, rng)
    A, F, ev = rows.A.to_numpy(), rows.F.to_numpy(), rows.event.to_numpy()
    keys = rows.series_key.to_numpy()
    flag = C.stockout_flag(rows, table)
    rng_b = np.random.default_rng(protocol["seeds"]["bootstrap"])
    cells, gates = [], {}
    for key, method in protocol["selections"]["totals_uncertainty"].items():
        seg, h, p = key.split("|")
        h, p = int(h), float(p)
        for meth in ("U0", "U1", "U2", "U3"):
            u = up[(meth, p)]
            mask = (rows.group == seg).to_numpy() & (rows.h == h).to_numpy() & np.isfinite(u)
            if not mask.any():
                continue
            rec = C.coverage_cell(A, F, u, mask, ev, p, seg, keys, rows.origin, start, rng_b)
            m2 = mask & ~flag
            rec["coverage_excluding_stockout_flag"] = C.fstr(Fraction(int((A[m2] <= u[m2]).sum()), int(m2.sum()))) if m2.any() else None
            rec.update({"cell": key, "method": meth, "selected": meth == method})
            cells.append(rec)
            if meth == method:
                occ = C.event_occurrences_in_windows(rows.loc[mask & ev], E.us_calendar(), E.PRIMARY_US)
                g = {"within_tolerance_event": rec["within_tolerance_event"], "within_tolerance_non_event": rec["within_tolerance_non_event"],
                     "windows_ge_200": rec["windows"] >= C.MIN_WINDOWS, "series_ge_30": rec["series"] >= C.MIN_SERIES,
                     "primary_occurrences_ge_2": len(occ) >= 2, "primary_occurrences": occ}
                g["pass"] = all(v for k, v in g.items() if k != "primary_occurrences")
                gates[key] = g
        if method is None:
            gates[key] = {"pass": False, "reason": "no development selection (no suggestion)"}
    log(f"totals uncertainty: {sum(1 for g in gates.values() if g['pass'])} of {len(gates)} cells pass")
    return cells, gates


def decisions_us(rows, table, calib, protocol, start, log):
    rng = np.random.default_rng(protocol["seeds"]["decisions"])
    res, meta = C.decision_track(rows, table, calib["D1_r"], rng, progress=log)
    cells = C.decision_cells(res)
    rng_b = np.random.default_rng(protocol["seeds"]["bootstrap"])
    caps = protocol["selections"]["decision_caps"]
    out = {}
    for rule in ("A2_kappa_robust", "A0_original"):
        sel = protocol["selections"][f"decision_{rule}"]
        gates = {}
        for key, m in sel.items():
            seg, p = key.split("|")
            p = float(p)
            if m is None:
                gates[key] = {"pass": False, "reason": "no development selection (no suggestion)"}
                continue
            c = cells.loc[(cells.segment == seg) & (cells.method == m)]
            need = c if rule == "A2_kappa_robust" else c.loc[c.kappa == 1.0]
            cov = [{"scenario": x.scenario, "L": int(x.L), "R": int(x.R), "kappa": float(x.kappa), "decisions": int(x.decisions),
                    "coverage": C.fstr(Fraction(int(x.hits), int(x.decisions))) if x.decisions else None,
                    "within": C.within_tolerance(x.hits, x.decisions, p, C.tolerance(seg))} for x in need.itertuples()]
            ratios = []
            for x in need.itertuples():
                d0 = cells.loc[(cells.segment == seg) & (cells.method == "D0") & (cells.scenario == x.scenario) & (cells.L == x.L)
                               & (cells.R == x.R) & (cells.kappa == x.kappa)].iloc[0]
                ratio, avoided, excess = C.excess_ratio(x, d0)
                ratios.append({"scenario": x.scenario, "L": int(x.L), "R": int(x.R), "kappa": float(x.kappa),
                               "avoided_per_decision": C.fstr(avoided), "excess_per_decision": C.fstr(excess),
                               "ratio": None if ratio is None else C.fstr(ratio),
                               "mean_Q": C.fstr(Fraction(int(x.sum_Q), int(x.decisions))),
                               "mean_Q_D0": C.fstr(Fraction(int(d0.sum_Q), int(d0.decisions))),
                               "shortage_before_arrival_per_decision": C.fstr(Fraction(int(x.sum_sba), int(x.decisions)))})
            # pooled shortage reduction, kappa = 1, all pairs and scenarios, paired per decision
            k1 = res.loc[(res.segment == seg) & (res.kappa == 1.0)]
            a = k1.loc[k1.method == "D0"].set_index(["decision", "L", "R", "scenario"]).lost
            b = k1.loc[k1.method == m].set_index(["decision", "L", "R", "scenario"]).lost.reindex(a.index)
            diff = (a - b).to_numpy(dtype=float)
            org = pd.DatetimeIndex(k1.loc[k1.method == "D0"].origin)
            prod = k1.loc[k1.method == "D0"]["product"].to_numpy()
            ci_date = C.bootstrap_ci(lambda ix: diff[ix].mean(), C.date_blocks(org, start), rng_b)
            ci_prod = C.bootstrap_ci(lambda ix: diff[ix].mean(), prod, rng_b)
            cap = Fraction(caps[key]["cap"]["exact"]) if (rule == "A2_kappa_robust" and key in caps) else None
            g = {"decisions_ge_200_every_cell": bool(int(need.decisions.min()) >= C.MIN_DECISIONS),
                 "coverage_within_tolerance_every_cell": all(x["within"] for x in cov),
                 "shortage_avoided_every_cell": all(Fraction(r["avoided_per_decision"]["exact"]) > 0 for r in ratios),
                 "pooled_shortage_reduction_date_block_lower_gt_0": ci_date[0] is not None and ci_date[0] > 0}
            if cap is not None:
                g["excess_per_avoided_le_cap_every_cell"] = all(r["ratio"] is not None and Fraction(r["ratio"]["exact"]) <= cap for r in ratios)
            g["pass"] = all(g.values()) and (cap is not None or rule == "A0_original")
            if rule == "A0_original":
                g["note"] = "original development selection, reported for disclosure; it does not authorise a suggestion"
            gates[key] = {**g, "method": m, "cap": None if cap is None else C.fstr(cap), "coverage_cells": cov, "stock_cells": ratios,
                          "pooled_shortage_reduction_mean": float(diff.mean()) if len(diff) else None,
                          "pooled_shortage_reduction_date_block_95": ci_date, "pooled_shortage_reduction_product_cluster_95": ci_prod}
        out[rule] = gates
    log(f"decision gates (A2): {sum(1 for g in out['A2_kappa_robust'].values() if g['pass'])} of {len(out['A2_kappa_robust'])} pass")
    table = cells.copy()
    return out, meta, table


def run_us(mode, protocol, calib, u2, gate, out, log):
    p = protocol["us"]
    if mode == "rehearse":
        res = json.loads(D.RESERVATION.read_text())
        products = sorted(res["development_extra_products"])
        start, end = p["rehearsal_windows_within"]
        long = D.m5_daily(products, end)                         # guarded development loader
        launches = D.m5_launch_dates(products)
    else:
        start, end = p["final_windows_within"]
        products = sorted(D.reserved_products())
        long = FA.m5_final(gate, products)
        launches = D.m5_launch_dates(products)
    table = us_table_from_long(long, launches)
    log(f"US series: {len(table)}")
    boosters, _ = C.production_boosters()
    rows, X, parity = C.serve(table, C.origins_every(start, end, 7), boosters)
    log(f"US windows served: {len(rows)}; parity max |diff| = {parity:.3e}")
    if parity >= 1e-3:
        raise SystemExit("parity with the application failed; stopping before any metric is computed")
    calendar = E.us_calendar()
    rows = C.flag_events(rows, calendar, E.PRIMARY_US)
    rng = np.random.default_rng(protocol["seeds"]["bootstrap"])
    e1, e1_gates = event_layer_us(rows, calendar, rng, start, log)
    cells, t_gates = totals_us(rows, X, table, calib, u2, protocol, start, log)
    d_gates, d_meta, d_cells = decisions_us(rows, table, calib, protocol, start, log)
    d_cells.to_csv(out / "us_decision_cells.csv", index=False)
    pd.DataFrame(cells).to_json(out / "us_totals_cells.json", orient="records", indent=1)
    return {"series": len(table), "windows": int(len(rows)), "parity_max_abs_units": parity,
            "windows_within": [start, end], "primary_occurrences": C.event_occurrences_in_windows(rows, calendar, E.PRIMARY_US),
            "e1c": e1, "e1c_gates": e1_gates, "totals_gates": t_gates, "decision_gates": d_gates, "decision_meta": d_meta}


# ----------------------------------------------------------------------------- Pakistan evaluation
def run_pk(mode, protocol, calib, gate, out, log, pk_source=None):
    p = protocol["pakistan"]
    if mode == "rehearse":
        start, end = p["rehearsal_windows_within"]
        df = D.pakistan_dev()
        table = pk_table_from_df(df, "2016-07-01", "2017-12-31")
        calendar = E.pk_calendar()
    else:
        start, end = p["final_windows_within"]
        df = FA.pakistan_final(gate, pk_source, p["source_sha256"])
        table = pk_table_from_df(df, "2016-07-01", "2018-08-28")
        calendar = pk_calendar(protocol)
    boosters, _ = C.production_boosters()
    rows_all, X, parity = C.serve(table, C.origins_every(start, end, 7), boosters)
    if parity >= 1e-2:
        raise SystemExit("parity with the application failed")
    rows_all = C.flag_events(rows_all, calendar, E.PRIMARY_PK)
    named = (rows_all.series_key != UNCAT).to_numpy()
    base = []
    for scope, m0 in (("named_categories", named), ("uncategorised", ~named)):
        for h in C.HORIZONS:
            for kind in ("all", "event", "non_event"):
                m = m0 & (rows_all.h == h).to_numpy()
                if kind != "all":
                    m = m & (rows_all.event.to_numpy() if kind == "event" else ~rows_all.event.to_numpy())
                t = rows_all.loc[m]
                base.append({"scope": scope, "h": h, "kind": kind, "windows": int(m.sum()), "wape": C.wape(t.F, t.A), "bias_pct": C.bias(t.F, t.A)})
    rows = rows_all.loc[named].reset_index(drop=True)
    # E1 (Independence Day, Eid al-Adha), frozen beta
    e1c = calib["e1"]
    names = E.feature_names(calendar)
    idx = [names.index(f) for f in e1c["features"]]
    beta = np.array(e1c["beta"])
    Xe = np.zeros((len(rows), len(idx)))
    for h in C.HORIZONS:
        m = (rows.h == h).to_numpy()
        Xe[m] = E.exposure(rows.loc[m, "origin"], h, calendar)[0][:, idx]
    F, A = rows.F.to_numpy(), rows.A.to_numpy()
    Fadj = np.where(F >= 1, F * np.exp(Xe @ beta), F)
    adj_ev = np.zeros(len(rows), dtype=bool)
    for h in C.HORIZONS:
        m = (rows.h == h).to_numpy()
        adj_ev[m] = E.event_window_flag(rows.loc[m, "origin"], h, calendar, e1c["events"])
    rng = np.random.default_rng(protocol["seeds"]["bootstrap"])
    blocks = C.date_blocks(rows.origin, start)
    cats = rows.series_key.to_numpy()
    e1 = {}
    for h in C.HORIZONS:
        m = (rows.h == h).to_numpy()
        e_, n_ = m & adj_ev, m & ~adj_ev
        rec = {"adjusted_event_windows": int(e_.sum()), "wape_event_base": C.wape(F[e_], A[e_]), "wape_event_e1": C.wape(Fadj[e_], A[e_]),
               "wape_other_base": C.wape(F[n_], A[n_]), "wape_other_e1": C.wape(Fadj[n_], A[n_]),
               "wape_all_base": C.wape(F[m], A[m]), "wape_all_e1": C.wape(Fadj[m], A[m]),
               "bias_event_base": C.bias(F[e_], A[e_]), "bias_event_e1": C.bias(Fadj[e_], A[e_])}
        rec["rel_event_improvement"] = ((rec["wape_event_base"] - rec["wape_event_e1"]) / rec["wape_event_base"]) if e_.any() else None
        ii = np.flatnonzero(e_)

        def stat(ix, ii=ii):
            sub = ii[ix]
            w0 = np.abs(F[sub] - A[sub]).sum()
            return (w0 - np.abs(Fadj[sub] - A[sub]).sum()) / w0 if w0 else None
        rec["date_block_95"] = C.bootstrap_ci(stat, blocks[ii], rng) if len(ii) else [None, None]
        rec["category_cluster_95"] = C.bootstrap_ci(stat, cats[ii], rng) if len(ii) else [None, None]
        e1[str(h)] = rec
    g = {"event_improvement_ge_5pct_both_horizons": all(e1[str(h)]["rel_event_improvement"] is not None and e1[str(h)]["rel_event_improvement"] >= 0.05 for h in C.HORIZONS),
         "overall_and_other_no_worse_than_plus_0_5_points": all(e1[str(h)]["wape_all_e1"] <= e1[str(h)]["wape_all_base"] + 0.5 and
                                                                 e1[str(h)]["wape_other_e1"] <= e1[str(h)]["wape_other_base"] + 0.5 for h in C.HORIZONS),
         "event_bias_not_larger": all(abs(e1[str(h)]["bias_event_e1"]) <= abs(e1[str(h)]["bias_event_base"]) for h in C.HORIZONS if e1[str(h)]["adjusted_event_windows"]),
         "intervals_exclude_zero": all(e1[str(h)][k][0] is not None and e1[str(h)][k][0] > 0 for h in C.HORIZONS for k in ("date_block_95", "category_cluster_95")),
         "fit_occurrences_ge_2": all(len(v) >= 2 for v in e1c["fit_occurrences"].values())}
    g["pass"] = all(g.values())
    # U0/U1 coverage (descriptive: 15 category series cannot meet the 30-series requirement)
    unc = []
    ev = rows.event.to_numpy()
    for h in C.HORIZONS:
        for pl in C.LEVELS:
            m = (rows.h == h).to_numpy()
            for meth in ("U0", "U1"):
                q = calib[meth][f"pooled|{h}|{pl}"]
                up = np.maximum((F + 1) * q - 1, 0) if meth == "U0" else np.maximum(F + q * np.sqrt(F + 1), 0)
                rec = C.coverage_cell(A, F, up, m, ev, pl, "pooled", cats, rows.origin, start, rng)
                rec.update({"h": h, "p": pl, "method": meth, "suggestion_possible": False,
                            "reason": "category series (15) are below the 30-series requirement and are not inventory units"})
                unc.append(rec)
    log(f"PK: windows {len(rows)}; E1 gates pass={g['pass']}")
    return {"windows_within": [start, end], "parity_max_abs_units": parity, "base_accuracy": base, "e1": e1, "e1_gates": g,
            "uncertainty_descriptive": unc, "categories": sorted(set(cats))}


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--rehearse", action="store_true")
    mode.add_argument("--execute-once", action="store_true")
    ap.add_argument("--confirm", help="sha256 of outputs/final_protocol.json (execute-once)")
    ap.add_argument("--calibration", required=True, help="folder with calibration_us.json, calibration_pk.json (and calibration_freeze.json)")
    ap.add_argument("--calibration-freeze-sha", help="sha256 of calibration_freeze.json (execute-once)")
    ap.add_argument("--pakistan-source", help="full Pakistan source CSV (execute-once)")
    ap.add_argument("--lock-dir", help="folder for the one-time lock (execute-once)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    t0 = time.time()
    out = Path(a.out)
    protocol_text = PROTOCOL.read_bytes()
    protocol = json.loads(protocol_text)
    protocol_sha = D.sha256(PROTOCOL)
    if PROTOCOL_SHA.read_text().split()[0] != protocol_sha:
        raise SystemExit("final_protocol.json differs from its frozen hash file")
    bad = verify_hashes(protocol, C.STAGE3.parents[1])
    if bad:
        raise SystemExit(f"hash mismatch, refusing to run: {bad}")
    cal_dir = Path(a.calibration)
    gate = None
    if a.execute_once:
        if a.confirm != protocol_sha:
            raise SystemExit("--confirm must equal the sha256 of final_protocol.json")
        if not (a.calibration_freeze_sha and a.pakistan_source and a.lock_dir):
            raise SystemExit("--calibration-freeze-sha, --pakistan-source and --lock-dir are required")
        verify_calibration(cal_dir, a.calibration_freeze_sha)
        if out.exists() and any(out.iterdir()):
            raise SystemExit("output folder is not empty; the final evaluation runs once")
        lock_dir = Path(a.lock_dir)
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock = lock_dir / "STAGE3_FINAL_EVALUATION.lock"
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise SystemExit(f"lock exists ({lock}): the final evaluation has already been started once")
        os.write(fd, json.dumps({"protocol_sha256": protocol_sha, "started_at": datetime.now(timezone.utc).isoformat()}).encode())
        os.close(fd)
        gate = FA.FinalGate(FA.FinalGate._token, protocol_sha, str(lock))
        run_mode = "final"
    else:
        run_mode = "rehearse"
    out.mkdir(parents=True, exist_ok=True)
    logf = (out / "run.log").open("a")

    def log(msg):
        line = f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()
    log(f"mode={run_mode} protocol={protocol['protocol_id']} sha={protocol_sha}")
    calib_us = json.loads((cal_dir / "calibration_us.json").read_text())
    calib_pk = json.loads((cal_dir / "calibration_pk.json").read_text())
    from calibrate import selected_u2
    u2 = selected_u2()
    results = {"label": "REHEARSAL on development data: not evidence" if run_mode == "rehearse" else "FINAL EVALUATION (one time)",
               "protocol_id": protocol["protocol_id"], "protocol_sha256": protocol_sha,
               "calibration_freeze_sha256": a.calibration_freeze_sha, "started_at": datetime.now(timezone.utc).isoformat(),
               "environment": {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__, "xgboost": xgb.__version__}}
    results["us"] = run_us(run_mode, protocol, calib_us, u2, gate, out, log)
    results["pakistan"] = run_pk(run_mode, protocol, calib_pk, gate, out, log, a.pakistan_source)
    results["seconds"] = round(time.time() - t0, 1)
    results["production_unchanged"] = protocol["production_unchanged"]
    (out / "results.json").write_text(json.dumps(results, indent=2, default=str) + "\n")
    summary = {
        "label": results["label"],
        "e1c_us_pass": results["us"]["e1c_gates"]["pass"],
        "totals_cells_pass": {k: v["pass"] for k, v in results["us"]["totals_gates"].items()},
        "decision_A2_pass": {k: v["pass"] for k, v in results["us"]["decision_gates"]["A2_kappa_robust"].items()},
        "pakistan_e1_pass": results["pakistan"]["e1_gates"]["pass"],
    }
    (out / "gates_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    hashes = {f.name: D.sha256(f) for f in sorted(out.iterdir()) if f.is_file() and f.name != "SHA256SUMS"}
    (out / "SHA256SUMS").write_text("".join(f"{v}  {k}\n" for k, v in hashes.items()))
    log(f"done in {results['seconds']} s")


if __name__ == "__main__":
    main()
