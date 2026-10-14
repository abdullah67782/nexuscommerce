"""Shared run logic for the sequential evaluation (development rehearsal and the one-time final run)."""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
STAGE3 = HERE.parent
sys.path.insert(0, str(STAGE3 / "final"))
sys.path.insert(0, str(HERE))
import common as C  # noqa: E402
import replay as RP  # noqa: E402
import evaluate as EV  # noqa: E402

PROTOCOL_V1 = STAGE3 / "outputs" / "final_protocol.json"


def frozen_cells():
    """The frozen A2 selections (protocol v1): {'regular|0.9': ('regular', 0.9, closure?)...}."""
    sel = json.loads(PROTOCOL_V1.read_text())["selections"]["decision_A2_kappa_robust"]
    cells = {}
    for key, m in sel.items():
        if not m:
            continue
        seg, p = key.split("|")
        meth, lvl = m.split("@")
        assert meth in ("D2", "D2c") and float(lvl) == float(p)
        cells[key] = (seg, float(p), meth == "D2c")
    return cells


def serve_reviews(table, boosters, log):
    """Frozen-release forecasts (7 and 28 days) at every 7-day review of the replay, from history up to that day."""
    padded = {k: {"start": v["start"], "values": np.concatenate([v["values"], np.zeros(28)]), "cat": v["cat"]} for k, v in table.items()}
    reviews = list(range(0, RP.REPLAY_DAYS, 7))
    by_start = {}
    for k, v in table.items():
        by_start[k] = v["i0"]

    def origins(s, h):
        i0 = by_start[s.key]
        return np.array([i0 + t for t in reviews])
    rows, _X, parity = C.serve(padded, origins, boosters)
    log(f"served {len(rows)} forecasts at {len(reviews)} reviews; parity with ml/v2 max |diff| = {parity:.3e}")
    return rows, parity


def run(table, start, boosters, log, seed, record=None, cells=None):
    t0 = time.time()
    rows, parity = serve_reviews(table, boosters, log)
    prep = RP.Prepared(table, rows, start)
    missing = int(np.isnan(prep.T28).sum())
    log(f"series {len(prep.keys)}; reviews {len(prep.reviews)}; missing forecasts {missing}")
    cells = cells or frozen_cells()
    groups = {7: [(L, R, k) for (L, R) in RP.PAIRS if R == 7 for k in RP.KAPPAS],
              14: [(L, R, k) for (L, R) in RP.PAIRS if R == 14 for k in RP.KAPPAS]}
    allrows = np.arange(len(prep.keys))
    policies = {"D0": ("D0",), **{f"S{k}": ("S", k) for k in RP.SELLER_DAYS}}
    res = {}
    sources = {}

    def put(name, cfgs, out, rows_=None):
        res.setdefault(name, {})
        for c, (L, R, k) in enumerate(cfgs):
            full = {}
            for key, val in out.items():
                if key == "path_sources":
                    continue
                arr = val[c]
                if rows_ is not None:                           # candidate run on a subset: embed into full-size arrays
                    big = np.full((len(prep.keys),) + arr.shape[1:], np.nan)
                    big[rows_] = arr
                    arr = big
                full[key] = arr
            res[name].setdefault(k, {})[(L, R)] = full

    for name, pol in policies.items():
        for R, cfgs in groups.items():
            put(name, cfgs, RP.replay(prep, allrows, cfgs, pol, seed, record=record if name in ("D0", "S7") else None))
        log(f"policy {name} done ({time.time() - t0:.0f}s)")
    for name, (seg, p, closure) in cells.items():
        rows_ = np.flatnonzero(prep.seg0 == seg)
        if not len(rows_):
            res[name] = None
            continue
        for R, cfgs in groups.items():
            out = RP.replay(prep, rows_, cfgs, ("M", seg, p, closure), seed)
            for s_, n in out["path_sources"].items():
                sources.setdefault(name, {})[s_] = sources.get(name, {}).get(s_, 0) + n
            put(name, cfgs, out, rows_)
        log(f"cell {name} ({len(rows_)} series) done ({time.time() - t0:.0f}s)")
    return prep, res, {"parity_max_abs_units": parity, "missing_forecasts": missing, "path_sources": sources,
                       "segments_at_start": pd.Series(prep.seg0).value_counts().to_dict(), "seconds": round(time.time() - t0, 1)}


def gates(prep, res, seed, parity_ok, cells=None):
    cells = cells or frozen_cells()
    out = {}
    for name, (seg, p, closure) in cells.items():
        rows_ = np.flatnonzero(prep.seg0 == seg)
        if res.get(name) is None:
            out[name] = {"cell": name, "series": 0, "passed": False, "reason": "no series in this segment at the start", "promotion_authorised": False}
            continue
        out[name] = EV.cell_gates(name, rows_, prep.item, res, RP.PAIRS, RP.SELLER_DAYS, seed, parity_ok)
    return out


def baselines(prep, res):
    """Descriptive: D0 and every seller rule, all series, pooled over pairs at kappa = 1."""
    allrows = np.arange(len(prep.keys))
    out = {}
    for name in ["D0"] + [f"S{k}" for k in RP.SELLER_DAYS]:
        s = EV.stack(res[name][1.0], RP.PAIRS, allrows)
        out[name] = {"lost": float(s["lost"].sum()), "demand": float(s["demand"].sum()), "fill_rate": float(1 - s["lost"].sum() / max(s["demand"].sum(), 1e-9)),
                     "hold_unit_days": float(s["hold_units"].sum()), "lost_value": float(s["lost_value"].sum()), "hold_value": float(s["hold_value"].sum()),
                     "stockout_days": float(s["stockout_days"].sum()), "ordered": float(s["ordered"].sum())}
    return out
