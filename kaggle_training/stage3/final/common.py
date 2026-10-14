"""Shared, frozen computations for the Stage 3 final calibration and the one-time final evaluation.

Everything here is a re-statement of the development code with these protocol corrections
(final protocol nexus-stage3-final-protocol-v1):
  * exact thresholds: tolerance and count checks use integer/Fraction arithmetic on unrounded counts;
    no displayed (rounded) value is ever compared with a threshold;
  * decision-specific quantities: every method is evaluated on the order quantity it produces for each
    decision; nothing assumes that Q_method - Q_D0 equals a constant safety stock;
  * the shortage/excess-stock gate (dev-anchored cap) and the kappa-robust amendment A2.
No function here reads data; callers pass series built by a guarded loader.
"""
import math
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np
import pandas as pd

STAGE3 = Path(__file__).resolve().parents[1]
if str(STAGE3) not in sys.path:
    sys.path.insert(0, str(STAGE3))

import data_access as D  # noqa: E402
import events as E  # noqa: E402
import u2_artifacts as U  # noqa: E402
from e1_layer import fit_poisson  # noqa: E402
from served import Series, parity_check, served  # noqa: E402  (inserts ml/ on sys.path)
from v2.registry import load_models  # noqa: E402

LEVELS = (0.8, 0.9)
HORIZONS = (7, 28)
SEGMENTS = ["regular", "occasional", "rare", "dormant", "short_history"]
PAIRS = [(3, 7), (7, 7), (3, 14), (7, 14), (14, 7)]
KAPPAS = (0.5, 1.0, 1.5)
SCENARIOS = ("none", "mid")
J_PATHS = 100
MIN_WINDOWS, MIN_SERIES, MIN_DECISIONS = 200, 30, 200
BOOT_B = 500
BLOCK_DAYS = 28
CLOSURE_EVENT_US = "Christmas"


# ----------------------------------------------------------------------------- exact thresholds
def frac(x):
    return Fraction(str(x))


def tolerance(segment):
    return Fraction("0.10") if segment == "rare" else Fraction("0.05")


def within_tolerance(hits, n, p, tol):
    """|hits/n - p| <= tol, evaluated exactly as |hits - p*n| <= tol*n on integers."""
    if n <= 0:
        return False
    return abs(Fraction(int(hits)) - frac(p) * int(n)) <= frac(tol) * int(n)


def fstr(x):
    """Exact text of a Fraction for JSON (plus float for reading)."""
    x = Fraction(x)
    return {"exact": f"{x.numerator}/{x.denominator}", "value": float(x)}


# ----------------------------------------------------------------------------- serving
def make_series(table):
    return [Series(k, pd.date_range(table[k]["start"], periods=len(table[k]["values"])), table[k]["values"]) for k in sorted(table)]


def origins_every(start, end, step):
    start, end = pd.Timestamp(start), pd.Timestamp(end)

    def fn(s, h):
        days = pd.date_range(start, end - pd.Timedelta(days=h - 1), freq=f"{step}D")
        return np.array([(d - s.start).days for d in days])
    return fn


def serve(table, origins_fn, boosters, chunk=300, parity_rows=300):
    """As-served v2 forecasts with feature rows (app code); returns (rows, X, parity_max_abs_units)."""
    keys = sorted(table)
    parts, feats, worst = [], {h: [] for h in HORIZONS}, 0.0
    for c in range(0, len(keys), chunk):
        ss = make_series({k: table[k] for k in keys[c:c + chunk]})
        rows, Xs = served(ss, origins_fn, boosters, with_features=True)
        if c == 0:
            worst = parity_check(ss, boosters, rows, n=parity_rows)
        keys_ = list(rows.key)
        rows["table_key"] = pd.Series(keys_, index=rows.index, dtype=object)
        rows["series_key"] = [k if isinstance(k, str) else f"{k[0]}|{k[1]}" for k in keys_]
        rows["cat"] = [table[k].get("cat", k if isinstance(k, str) else None) for k in keys_]
        rows["store_id"] = [None if isinstance(k, str) else k[0] for k in keys_]
        rows["item_id"] = [k if isinstance(k, str) else k[1] for k in keys_]
        for h in HORIZONS:
            feats[h].append(Xs[h][rows.loc[rows.h == h, "_xrow"].astype(int).to_numpy()])
        parts.append(rows.drop(columns=["key"]))
    rows = pd.concat(parts, ignore_index=True)
    X = {h: np.concatenate(feats[h]) for h in HORIZONS}
    for h in HORIZONS:
        rows.loc[rows.h == h, "_xrow"] = np.arange((rows.h == h).sum())
    rows = rows.loc[rows.method.notna()].reset_index(drop=True)
    return rows, X, float(worst)


def production_boosters():
    boosters, manifest = load_models()
    return boosters, manifest


# ----------------------------------------------------------------------------- events
def flag_events(rows, calendar, primary):
    rows["event"] = False
    for h in HORIZONS:
        m = rows.h == h
        rows.loc[m, "event"] = E.event_window_flag(rows.loc[m, "origin"], h, calendar, primary)
    return rows


def event_occurrences_in_windows(rows, calendar, primary):
    """Distinct primary-event dates whose [d-7, d+3] overlaps at least one window in `rows`."""
    out = set()
    for _, ev in calendar.loc[calendar.event.isin(primary)].iterrows():
        d = pd.Timestamp(ev.date)
        for h in HORIZONS:
            o = rows.loc[rows.h == h, "origin"]
            end = o + pd.Timedelta(days=h - 1)
            if ((o <= d + pd.Timedelta(days=3)) & (end >= d - pd.Timedelta(days=7))).any():
                out.add((ev.event, str(d.date())))
    return sorted(out)


def closed_days(origins, h, calendar, closure_event=CLOSURE_EVENT_US):
    o = pd.DatetimeIndex(origins).values.astype("datetime64[D]").astype(np.int64)
    c = np.zeros(len(o))
    for d in calendar.loc[calendar.event == closure_event, "date"]:
        dd = np.int64(np.datetime64(d, "D").astype(np.int64))
        c += ((o <= dd) & (dd <= o + h - 1))
    return c


def apply_e1c(rows, calendar):
    """Amendment A1 candidate E1c (frozen): F * (h - closed days)/h on rows with F >= 1."""
    out = rows.F.to_numpy().copy()
    for h in HORIZONS:
        m = (rows.h == h).to_numpy() & (rows.F >= 1.0).to_numpy()
        c = closed_days(rows.loc[m, "origin"], h, calendar)
        out[m] = out[m] * (h - c) / h
    return out


def wape(F, A):
    A = np.asarray(A, dtype=float)
    return float(100 * np.abs(np.asarray(F) - A).sum() / A.sum()) if A.sum() else float("nan")


def bias(F, A):
    A = np.asarray(A, dtype=float)
    return float(100 * (np.asarray(F) - A).sum() / A.sum()) if A.sum() else float("nan")


# ----------------------------------------------------------------------------- bootstraps
def date_blocks(origins, start):
    return ((pd.DatetimeIndex(origins) - pd.Timestamp(start)).days // BLOCK_DAYS).to_numpy()


def bootstrap_ci(stat, groups, rng, B=BOOT_B):
    """Cluster bootstrap: resample whole groups (date blocks or products) with replacement.
    stat(index_array) -> float. Returns [2.5%, 97.5%] (None if undefined)."""
    groups = np.asarray(groups)
    ug = np.unique(groups)
    members = {g: np.flatnonzero(groups == g) for g in ug}
    vals = []
    for _ in range(B):
        pick = rng.choice(ug, size=len(ug), replace=True)
        idx = np.concatenate([members[g] for g in pick])
        v = stat(idx)
        if v is not None and np.isfinite(v):
            vals.append(v)
    if not vals:
        return [None, None]
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


# ----------------------------------------------------------------------------- uncertainty of totals
def calibrate_totals(rows, X, u2_boosters):
    """Frozen calibration quantities from calibration rows (method not null).
    Returns {"U0": {seg|h|p: q}, "U1": {...}, "U2_correction": {...}, "D1_r": {seg|p: q}, "counts": {seg|h: n}}."""
    out = {"U0": {}, "U1": {}, "U2_correction": {}, "D1_r": {}, "counts": {}}
    for (seg, h), c in rows.groupby(["group", "h"]):
        out["counts"][f"{seg}|{h}"] = int(len(c))
        for p in LEVELS:
            out["U0"][f"{seg}|{h}|{p}"] = float(U.finite_q((c.A + 1) / (c.F + 1), p))
            out["U1"][f"{seg}|{h}|{p}"] = float(U.finite_q((c.A - c.F) / np.sqrt(c.F + 1), p))
            if h == 28:
                out["D1_r"][f"{seg}|{p}"] = out["U0"][f"{seg}|{h}|{p}"]
    for h in HORIZONS:
        for p in LEVELS:
            corr = U.corrections(u2_boosters[(h, p)], rows, X, h, p)
            for seg, v in corr.items():
                out["U2_correction"][f"{seg}|{h}|{p}"] = v
    return out


def tsb_probability(v, i, beta=0.1):
    pos = np.flatnonzero(v[:i] > 0)
    if not len(pos):
        return 0.0
    first = pos[0]
    prob = 1 / (first + 1)
    for q in v[first + 1:i]:
        prob += beta * (float(q > 0) - prob)
    return prob


def u3_uppers(rows, table, rng, draws=400):
    """TSB bootstrap (development U3), rare rows only; rows in the given order."""
    out = {p: np.full(len(rows), np.nan) for p in LEVELS}
    for r, row in enumerate(rows.itertuples()):
        v = table[row.table_key]["values"]
        i = int(row.i)
        prob = tsb_probability(v, i)
        hist = v[max(0, i - 180):i]
        sizes = hist[hist > 0]
        if not len(sizes) or prob <= 0:
            for p in LEVELS:
                out[p][r] = 0.0
            continue
        k = rng.binomial(int(row.h), prob, size=draws)
        tot = np.array([rng.choice(sizes, size=kk).sum() if kk else 0.0 for kk in k])
        for p in LEVELS:
            out[p][r] = np.quantile(tot, p)
    return out


def totals_uppers(rows, X, table, calib, u2_boosters, rng):
    """All candidate upper bounds for every row: {(method, p): array aligned with rows}."""
    F = rows.F.to_numpy()
    up = {}
    for p in LEVELS:
        u0, u1 = np.full(len(rows), np.nan), np.full(len(rows), np.nan)
        for (seg, h), idx in rows.groupby(["group", "h"]).groups.items():
            pos = rows.index.get_indexer(idx)
            k = f"{seg}|{h}|{p}"
            if k in calib["U0"]:
                u0[pos] = (F[pos] + 1) * calib["U0"][k] - 1
                u1[pos] = F[pos] + calib["U1"][k] * np.sqrt(F[pos] + 1)
        up[("U0", p)] = np.maximum(u0, 0)
        up[("U1", p)] = np.maximum(u1, 0)
        u2 = np.full(len(rows), np.nan)
        for h in HORIZONS:
            corr = {seg: calib["U2_correction"][f"{seg}|{h}|{p}"] for seg in SEGMENTS if f"{seg}|{h}|{p}" in calib["U2_correction"]}
            pos = np.flatnonzero((rows.h == h).to_numpy())
            u2[pos] = U.uppers(u2_boosters[(h, p)], corr, rows, X, h)
        up[("U2", p)] = u2
    rare = (rows.group == "rare").to_numpy()
    u3 = u3_uppers(rows.loc[rare], table, rng)
    for p in LEVELS:
        a = np.full(len(rows), np.nan)
        a[rare] = u3[p]
        up[("U3", p)] = a
    return up


def stockout_flag(rows, table):
    """Heuristic only (no censoring): regular series, >= 3 consecutive zero days in the window outside 25 December."""
    flags = np.zeros(len(rows), dtype=bool)
    for r, row in enumerate(rows.itertuples()):
        if row.group != "regular":
            continue
        s = table[row.table_key]
        w = s["values"][int(row.i):int(row.i) + int(row.h)]
        days = pd.date_range(s["start"] + pd.Timedelta(days=int(row.i)), periods=len(w))
        z = (w == 0) & ~((days.month == 12) & (days.day == 25))
        run = best = 0
        for x in z:
            run = run + 1 if x else 0
            best = max(best, run)
        flags[r] = best >= 3
    return flags


def coverage_cell(A, F, up, mask, event, p, segment, keys, origins, start, rng):
    """Exact coverage record for one (method, segment, horizon, level) cell.
    Coverage = share of windows whose actual total is <= the method's upper p-quantile (one-sided)."""
    hit = A <= up
    rec = {"windows": int(mask.sum()), "series": int(pd.unique(keys[mask]).size)}
    for kind, m in (("all", mask), ("event", mask & event), ("non_event", mask & ~event)):
        n, k = int(m.sum()), int(hit[m].sum())
        rec[f"n_{kind}"], rec[f"hits_{kind}"] = n, k
        rec[f"coverage_{kind}"] = fstr(Fraction(k, n)) if n else None
        rec[f"within_tolerance_{kind}"] = within_tolerance(k, n, p, tolerance(segment))
    blocks = date_blocks(origins, start)
    idx_all = np.flatnonzero(mask)
    rec["coverage_date_block_95"] = bootstrap_ci(lambda ix: hit[idx_all[ix]].mean() if len(ix) else None, blocks[idx_all], rng)
    rec["mean_rel_width"] = float(np.mean((up[mask] - F[mask]) / (F[mask] + 1))) if mask.any() else None
    return rec


# ----------------------------------------------------------------------------- decision track
def min_q(paths, S0, a, R, inc=None):
    """Stage 2 daily-checkpoint minimum quantity (continuous) for each path; inc = (offset in window, units)."""
    pre = paths[:, :a - 1].sum(axis=1)
    stock = np.maximum(0.0, S0 - pre)
    B = stock[:, None] - np.cumsum(paths[:, a - 1:a - 1 + R], axis=1)
    if inc is not None:
        B[:, inc[0]:] += inc[1]
    return np.maximum(0.0, -B.min(axis=1))


def min_q_with_ss(paths, S0, a, R, SS, inc=None):
    pre = paths[:, :a - 1].sum(axis=1)
    stock = np.maximum(0.0, S0 - pre)
    B = stock[:, None] - np.cumsum(paths[:, a - 1:a - 1 + R], axis=1)
    if inc is not None:
        B[:, inc[0]:] += inc[1]
    return np.maximum(0.0, np.maximum(-B.min(axis=1), SS - B[:, -1]))


def whole(x):
    return np.where(x <= 1e-9, 0, np.ceil(x - 1e-6))


def analogues(v, i):
    starts = [i - 7 * k for k in range(4, 53) if i - 7 * k >= 28]
    if not starts:
        return np.zeros((0, 28))
    return np.stack([v[u:u + 28] / (v[u - 28:u].mean() + 1.0) for u in starts])


METHODS = ["D0"] + [f"{m}@{p}" for p in LEVELS for m in ("D1", "D2", "D2c")]
COMBOS = [(L, R, k) for (L, R) in PAIRS for k in (KAPPAS if (L, R) == (7, 7) else (1.0,))]


def decision_track(rows, table, d1_r, rng, progress=None):
    """Development decision track (us_decisions.py) with D1's r_p from the frozen calibration.
    Every quantity is the decision's own order quantity. Returns a DataFrame (one row per decision x combo x
    scenario x method) with integer-valued Q, lost, end stock and shortage before arrival."""
    t7 = rows.loc[rows.h == 7].set_index(["series_key", "origin"])
    dec = rows.loc[rows.h == 28].set_index(["series_key", "origin"]).join(t7[["F"]].rename(columns={"F": "T7"}), how="inner")
    dec = dec.rename(columns={"F": "T28"}).reset_index()
    inconsistent = int((dec.T28 < dec.T7).sum())
    dec = dec.loc[dec.T28 >= dec.T7].reset_index(drop=True)
    own = {r.Index: analogues(table[r.table_key]["values"], int(r.i)) for r in dec.itertuples()}
    pools = {}
    for key, g in dec.groupby(["cat", "group", "origin"]):
        mats = [own[ix] for ix in g.index if len(own[ix]) >= 6]
        if mats:
            allw = np.vstack(mats)
            pools[key] = allw[rng.choice(len(allw), size=min(len(allw), 400), replace=False)]
    n = len(dec) * len(COMBOS) * len(SCENARIOS) * len(METHODS)
    col = {"decision": np.empty(n, np.int32), "combo": np.empty(n, np.int8), "scen": np.empty(n, np.int8), "meth": np.empty(n, np.int8),
           "Q": np.empty(n, np.int64), "lost": np.empty(n, np.int64), "end_stock": np.empty(n, np.int64),
           "shortage_before_arrival": np.empty(n, np.int64), "christmas_in_window": np.empty(n, bool)}
    source = np.empty(len(dec), dtype=object)
    k_out = 0
    for r in dec.itertuples():
        if progress and r.Index % 5000 == 0:
            progress(f"decision {r.Index}/{len(dec)}")
        s = table[r.table_key]
        v = s["values"]
        i = int(r.i)
        actual = v[i:i + 28]
        point = np.concatenate([np.full(7, r.T7 / 7), np.full(21, (r.T28 - r.T7) / 21)])
        W = own[r.Index]
        src = "own"
        if len(W) < 6:
            W = pools.get((r.cat, r.group, r.origin), np.zeros((0, 28)))
            src = "pooled"
        if len(W):
            pick = W[rng.integers(0, len(W), size=J_PATHS)]
            m = pick.sum(axis=1).mean()
            paths = pick * (r.T28 / m) if m > 0 else np.zeros((J_PATHS, 28))
        else:
            paths = np.tile(point, (J_PATHS, 1))
            src = "none(point)"
        source[r.Index] = src
        days = pd.date_range(s["start"] + pd.Timedelta(days=i), periods=28)
        xmas = (days.month == 12) & (days.day == 25)
        paths_c = paths.copy()
        paths_c[:, xmas] = 0.0
        for ci, (L, R, kappa) in enumerate(COMBOS):
            a = L + 2
            xm = bool(xmas[a - 1:a - 1 + R].any())
            S0 = float(np.round(kappa * point[:a - 1].sum()))
            pre_act = float(actual[:a - 1].sum())
            stock_a = max(0.0, S0 - pre_act)
            for si, scenario in enumerate(SCENARIOS):
                inc = None
                if scenario == "mid":
                    off = R // 2
                    inc = (off, float(np.round(point[a - 1 + off:a - 1 + R].sum())))
                cum = np.cumsum(actual[a - 1:a - 1 + R])
                if inc is not None:
                    cum = cum - np.where(np.arange(R) >= inc[0], inc[1], 0.0)
                q_point = min_q(point[None, :], S0, a, R, inc=inc)[0]
                W_point = point[a - 1:a - 1 + R].sum()
                B_end_point = max(0.0, S0 - point[:a - 1].sum()) - W_point + (inc[1] if inc else 0.0)
                cand = {"D0": whole(q_point)}
                for p in LEVELS:
                    SS = (d1_r.get(f"{r.group}|{p}", 1.0) - 1) * W_point
                    cand[f"D1@{p}"] = whole(max(q_point, SS - B_end_point))
                    cand[f"D2@{p}"] = whole(np.quantile(min_q(paths, S0, a, R, inc=inc), p))
                    cand[f"D2c@{p}"] = whole(np.quantile(min_q(paths_c, S0, a, R, inc=inc), p))
                total_window = float(actual[a - 1:a - 1 + R].sum())
                sba = max(0.0, pre_act - S0)
                for mi, name in enumerate(METHODS):
                    Q = float(cand[name])
                    bal = stock_a + Q - cum
                    lost = max(0.0, -float(bal.min()))
                    col["decision"][k_out], col["combo"][k_out], col["scen"][k_out], col["meth"][k_out] = r.Index, ci, si, mi
                    col["Q"][k_out], col["lost"][k_out] = int(round(Q)), int(round(lost))
                    col["end_stock"][k_out] = int(round(stock_a + Q + (inc[1] if inc else 0.0) - total_window + lost))
                    col["shortage_before_arrival"][k_out], col["christmas_in_window"][k_out] = int(round(sba)), xm
                    k_out += 1
    assert k_out == n
    res = pd.DataFrame(col)
    cmb = pd.DataFrame(COMBOS, columns=["L", "R", "kappa"])
    res["L"], res["R"], res["kappa"] = cmb.L.to_numpy()[res.combo], cmb.R.to_numpy()[res.combo], cmb.kappa.to_numpy()[res.combo]
    res["scenario"] = np.array(SCENARIOS)[res.scen]
    res["method"] = np.array(METHODS)[res.meth]
    res["segment"] = dec.group.to_numpy()[res.decision]
    res["origin"] = dec.origin.to_numpy()[res.decision]
    res["product"] = dec.item_id.to_numpy()[res.decision] if "item_id" in dec else dec.table_key.to_numpy()[res.decision]
    res["success"] = res.lost == 0
    res = res.drop(columns=["combo", "scen", "meth"])
    meta = {"decisions": int(len(dec)), "inconsistent_skipped": inconsistent,
            "path_sources": pd.Series(source).value_counts().to_dict()}
    return res, meta


def decision_cells(res):
    """Exact integer sums per (segment, scenario, L, R, kappa, method)."""
    g = res.groupby(["segment", "scenario", "L", "R", "kappa", "method"])
    return g.agg(decisions=("success", "size"), hits=("success", "sum"), sum_Q=("Q", "sum"), sum_lost=("lost", "sum"),
                 sum_end=("end_stock", "sum"), sum_sba=("shortage_before_arrival", "sum")).reset_index()


def excess_ratio(cell, cell_d0):
    """(mean end stock - D0 mean end stock) / (D0 mean lost - mean lost), exactly; None if no shortage avoided."""
    n = int(cell.decisions)
    avoided = Fraction(int(cell_d0.sum_lost) - int(cell.sum_lost), n)
    excess = Fraction(int(cell.sum_end) - int(cell_d0.sum_end), n)
    return (excess / avoided if avoided > 0 else None), avoided, excess


def select_decisions(cells, rule, caps=None):
    """Frozen selection rules (exact). rule 'A0' = original development rule (kappa = 1, every pair and scenario);
    'A2' = kappa-robust amendment (also kappa 0.5 and 1.5 on (7, 7), both scenarios)."""
    out = {}
    for seg in SEGMENTS:
        for p in LEVELS:
            tol = tolerance(seg)
            ok = []
            for m in [f"D1@{p}", f"D2@{p}", f"D2c@{p}"]:
                c = cells.loc[(cells.segment == seg) & (cells.method == m)]
                need = c.loc[c.kappa == 1.0] if rule == "A0" else c
                expected = len(PAIRS) * len(SCENARIOS) + (0 if rule == "A0" else 2 * len(SCENARIOS))
                if len(need) != expected or int(need.decisions.min()) < MIN_DECISIONS:
                    continue
                if all(within_tolerance(x.hits, x.decisions, p, tol) for x in need.itertuples()):
                    k1 = c.loc[c.kappa == 1.0]
                    ok.append((Fraction(int(k1.sum_Q.sum()), int(k1.decisions.sum())), m))
            out[f"{seg}|{p}"] = min(ok)[1] if ok else None
    return out
