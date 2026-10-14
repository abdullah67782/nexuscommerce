"""US development: uncertainty for 7/28-day totals (U0-U3), calibrated on CAL, compared on SEL.

Coverage at level p = share of SEL windows with actual total <= the method's p-quantile.
Selection per segment x horizon x level (frozen rule): coverage within +/-5 points (+/-10 rare) in BOTH event
and non-event windows -> smallest mean (upper - F)/(F + 1); none -> no suggestion.
Writes outputs/us/uncertainty_results.csv, uncertainty_selection.json; caches SEL uppers for the decision track.
"""
import json
import math
import pickle

import numpy as np
import pandas as pd
import xgboost as xgb

import events as E
from served import tsb_prefix_rates  # noqa: F401  (same arithmetic family; probability recomputed below)
from us_backtest import CACHE, OUT

LEVELS = (0.8, 0.9)
SEGMENTS = ["regular", "occasional", "rare", "dormant", "short_history"]
RNG = np.random.default_rng(7)


def finite_q(x, p):
    x = np.sort(np.asarray(x, dtype=float))
    n = len(x)
    if n == 0:
        return np.nan
    k = min(n, math.ceil((n + 1) * p))
    return x[k - 1]


def tsb_probability(v, i, beta=0.1):
    pos = np.flatnonzero(v[:i] > 0)
    if not len(pos):
        return 0.0
    first = pos[0]
    prob = 1 / (first + 1)
    for q in v[first + 1:i]:
        prob += beta * (float(q > 0) - prob)
    return prob


def u3_upper(rows, table, levels, draws=400):
    out = {p: np.full(len(rows), np.nan) for p in levels}
    for r, (_, row) in enumerate(rows.iterrows()):
        v = table[(row.store_id, row.item_id)]["values"]
        i = int(row.i)
        prob = tsb_probability(v, i)
        hist = v[max(0, i - 180):i]
        sizes = hist[hist > 0]
        if not len(sizes) or prob <= 0:
            for p in levels:
                out[p][r] = 0.0
            continue
        k = RNG.binomial(int(row.h), prob, size=draws)
        tot = np.array([RNG.choice(sizes, size=kk).sum() if kk else 0.0 for kk in k])
        for p in levels:
            out[p][r] = np.quantile(tot, p)
    return out


def load(name):
    d = pickle.loads((CACHE / f"{name}.pkl").read_bytes())
    rows = d["rows"].loc[d["rows"].method.notna()].copy()
    return rows, d["X"]


def flag_events(rows, cal):
    rows["event"] = False
    for h in (7, 28):
        m = rows.h == h
        rows.loc[m, "event"] = E.event_window_flag(rows.loc[m, "origin"], h, cal, E.PRIMARY_US)
    return rows


def stockout_flag(rows, table):
    """Heuristic only: regular series with >= 3 consecutive zero days inside the window, outside 25 December."""
    flags = np.zeros(len(rows), dtype=bool)
    for r, (_, row) in enumerate(rows.iterrows()):
        if row.group != "regular":
            continue
        s = table[(row.store_id, row.item_id)]
        w = s["values"][int(row.i):int(row.i) + int(row.h)]
        days = pd.date_range(s["start"] + pd.Timedelta(days=int(row.i)), periods=len(w))
        z = (w == 0) & ~((days.month == 12) & (days.day == 25))
        run = best = 0
        for x in z:
            run = run + 1 if x else 0
            best = max(best, run)
        flags[r] = best >= 3
    return flags


def main():
    cal_events = E.us_calendar()
    table = pickle.loads((CACHE / "series.pkl").read_bytes())
    cal, Xcal = load("CAL")
    sel, Xsel = load("SEL")
    fit_parts = [load(p) for p in ("FIT_A", "FIT_B")]
    cal, sel = flag_events(cal, cal_events), flag_events(sel, cal_events)
    sel["stockout_flag"] = stockout_flag(sel, table)
    uppers = {}

    # U0 and U1 from CAL
    for p in LEVELS:
        u0, u1 = np.full(len(sel), np.nan), np.full(len(sel), np.nan)
        for (seg, h), c in cal.groupby(["group", "h"]):
            m = ((sel.group == seg) & (sel.h == h)).to_numpy()
            q0 = finite_q((c.A + 1) / (c.F + 1), p)
            u0[m] = (sel.F.to_numpy()[m] + 1) * q0 - 1
            q1 = finite_q((c.A - c.F) / np.sqrt(c.F + 1), p)
            u1[m] = sel.F.to_numpy()[m] + q1 * np.sqrt(sel.F.to_numpy()[m] + 1)
        uppers[("U0", p)] = np.maximum(u0, 0)
        uppers[("U1", p)] = np.maximum(u1, 0)

    # U2: quantile boosting trained on FIT weekly rows, conformal correction on CAL
    def feats(rows, X):
        out = []
        for h in (7, 28):
            r = rows.loc[rows.h == h]
            out.append(np.column_stack([X[h][r["_xrow"].astype(int).to_numpy()], np.log1p(r.F.to_numpy()),
                                        r.history_days.to_numpy(), r.sell_frac_180.to_numpy()]))
        return out
    fit_rows = pd.concat([f[0] for f in fit_parts], ignore_index=False)
    for p in LEVELS:
        u2 = np.full(len(sel), np.nan)
        for hi, h in enumerate((7, 28)):
            Xtr = np.vstack([feats(f[0], f[1])[hi] for f in fit_parts])
            ytr = np.concatenate([((f[0].loc[f[0].h == h, "A"] + 1) / (f[0].loc[f[0].h == h, "F"] + 1)).to_numpy() for f in fit_parts])
            model = xgb.XGBRegressor(n_estimators=250, max_depth=5, learning_rate=0.05, min_child_weight=20, subsample=0.85,
                                     objective="reg:quantileerror", quantile_alpha=p, tree_method="hist", n_jobs=2, random_state=42)
            model.fit(Xtr, ytr)
            ccal = cal.loc[cal.h == h]
            qcal = model.predict(feats(cal, Xcal)[hi])
            score = (ccal.A.to_numpy() + 1) / (ccal.F.to_numpy() + 1) - qcal
            ssel = sel.loc[sel.h == h]
            qsel = model.predict(feats(sel, Xsel)[hi])
            corr = np.zeros(len(ssel))
            for seg in SEGMENTS:
                mc = (ccal.group == seg).to_numpy()
                ms = (ssel.group == seg).to_numpy()
                if mc.any():
                    corr[ms] = finite_q(score[mc], p)
            idx = np.flatnonzero((sel.h == h).to_numpy())
            u2[idx] = np.maximum((qsel + corr) * (ssel.F.to_numpy() + 1) - 1, 0)
        uppers[("U2", p)] = u2
        print("U2", p, "done", flush=True)

    # U3 for rare rows only
    rare = sel.group == "rare"
    u3 = u3_upper(sel.loc[rare], table, LEVELS)
    for p in LEVELS:
        arr = np.full(len(sel), np.nan)
        arr[rare.to_numpy()] = u3[p]
        uppers[("U3", p)] = arr

    # evaluation and selection
    A, F = sel.A.to_numpy(), sel.F.to_numpy()
    records, selection = [], {}
    blocks = ((pd.DatetimeIndex(sel.origin) - pd.Timestamp("2014-11-01")).days // 28).to_numpy()
    for (method, p), up in uppers.items():
        for seg in SEGMENTS:
            for h in (7, 28):
                base = (sel.group == seg).to_numpy() & (sel.h == h).to_numpy() & np.isfinite(up)
                if not base.any():
                    continue
                rec = {"method": method, "p": p, "segment": seg, "h": h, "windows": int(base.sum()),
                       "series": int(sel.loc[base, ["store_id", "item_id"]].drop_duplicates().shape[0])}
                for kind, m in [("all", base), ("event", base & sel.event.to_numpy()), ("non_event", base & ~sel.event.to_numpy()),
                                ("all_excl_stockout_flag", base & ~sel.stockout_flag.to_numpy())]:
                    rec[f"coverage_{kind}"] = float(np.mean(A[m] <= up[m])) if m.any() else np.nan
                    rec[f"n_{kind}"] = int(m.sum())
                rec["mean_rel_width"] = float(np.mean((up[base] - F[base]) / (F[base] + 1)))
                rec["pinball"] = float(np.mean(np.maximum(p * (A[base] - up[base]), (p - 1) * (A[base] - up[base]))))
                records.append(rec)
    res = pd.DataFrame(records)
    for seg in SEGMENTS:
        for h in (7, 28):
            for p in LEVELS:
                tol = 0.10 if seg == "rare" else 0.05
                c = res.loc[(res.segment == seg) & (res.h == h) & (res.p == p)]
                ok = c.loc[(c.coverage_event.sub(p).abs() <= tol) & (c.coverage_non_event.sub(p).abs() <= tol)]
                small = c.n_all.max() < 200 if len(c) else True
                if ok.empty or small:
                    selection[f"{seg}|{h}|{p}"] = {"method": None, "reason": "insufficient sample" if small else "no candidate within tolerance"}
                    continue
                best = ok.sort_values("mean_rel_width").iloc[0]
                # date-block bootstrap interval for the selected method's coverage
                up = uppers[(best.method, p)]
                m = (sel.group == seg).to_numpy() & (sel.h == h).to_numpy() & np.isfinite(up)
                hit = (A <= up)
                ub = np.unique(blocks[m])
                bs = []
                for _ in range(500):
                    pick = RNG.choice(ub, size=len(ub))
                    w = np.concatenate([np.flatnonzero(m & (blocks == b)) for b in pick])
                    bs.append(hit[w].mean())
                selection[f"{seg}|{h}|{p}"] = {"method": best.method, "coverage_all": best.coverage_all, "coverage_event": best.coverage_event,
                                               "coverage_non_event": best.coverage_non_event, "mean_rel_width": best.mean_rel_width,
                                               "coverage_date_block_95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                                               "windows": int(best.windows), "series": int(best.series)}
    (OUT / "us").mkdir(exist_ok=True)
    res.to_csv(OUT / "us" / "uncertainty_results.csv", index=False)
    (OUT / "us" / "uncertainty_selection.json").write_text(json.dumps(selection, indent=2, default=float) + "\n")
    with open(CACHE / "sel_uppers.pkl", "wb") as f:
        pickle.dump({"index": sel.index.to_numpy(), "uppers": uppers, "stockout_flag": sel.stockout_flag.to_numpy()}, f)
    print(json.dumps(selection, indent=1, default=float)[:4000])


if __name__ == "__main__":
    main()
