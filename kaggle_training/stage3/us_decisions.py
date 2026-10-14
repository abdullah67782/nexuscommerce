"""US development: protection evaluated on the inventory decision itself (dev protocol 'decision_track_us').

For each SEL origin (every 7 days; 28-day window inside SEL) and planning pair (L, R):
  a = L + 2 (order usable), window a..a+R-1 (<= 28 days; L=14,R=14 excluded), S0 = round(kappa x point demand days 1..L+1)
  minQ(path) = Stage 2 daily-checkpoint quantity: stock at a-1 = max(0, S0 - demand days 1..a-1) (lost sales),
               Q = max(0, -min_k (stock_{a-1} - cumulative window demand to k))          (no safety stock)
  D0  Q = ceil(minQ(point path))                       point path = A1 spreading of T7, T28
  D1  Q = ceil(max(minQ(point), SS - B_end)), SS = (r_p - 1) x point window demand, r_p = U0 28-day ratio quantile (CAL)
  D2  Q = ceil(p-quantile over 100 P1 paths of minQ(path))
  D2c D2 with the selected event candidate E1c (calendar closure: 25 December demand set to 0 in each path)
Outcome on actual daily demand: SUCCESS = no shortage on any day of the window with Q added on day a.
Shortage before arrival = max(0, actual demand days 1..a-1 - S0), reported separately (an order today cannot fix it).
Scenarios: 'none' (no other incoming) and 'mid' (an existing order usable at day a + R//2 sized to the point demand of the
window's second half), where only the daily checkpoints catch a gap before that delivery.
Kappa sensitivity (0.5, 1.5) is run for (L, R) = (7, 7); every pair runs at kappa = 1.
"""
import json
import os
import pickle

import numpy as np
import pandas as pd

from us_backtest import CACHE, OUT
from us_uncertainty import finite_q

PAIRS = [(3, 7), (7, 7), (3, 14), (7, 14), (14, 7)]
KAPPAS = (0.5, 1.0, 1.5)
LEVELS = (0.8, 0.9)
J = 100
RNG = np.random.default_rng(20261015)
SEGMENTS = ["regular", "occasional", "rare", "dormant", "short_history"]


def min_q(paths, S0, a, R, SS=0.0, inc=None):
    """paths: [n, 28]. Stage 2 minimum quantity (continuous) for each path; inc = (day offset in window, units)."""
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
    W = np.stack([v[u:u + 28] / (v[u - 28:u].mean() + 1.0) for u in starts])
    return W


def main():
    table = pickle.loads((CACHE / "series.pkl").read_bytes())
    sel = pickle.loads((CACHE / "SEL.pkl").read_bytes())["rows"]
    sel = sel.loc[sel.method.notna()]
    cal = pickle.loads((CACHE / "CAL.pkl").read_bytes())["rows"]
    cal = cal.loc[cal.method.notna() & (cal.h == 28)]
    r_p = {(seg, p): finite_q((c.A + 1) / (c.F + 1), p) for seg, c in cal.groupby("group") for p in LEVELS}
    t7 = sel.loc[sel.h == 7].set_index(["store_id", "item_id", "origin"])
    dec = sel.loc[sel.h == 28].set_index(["store_id", "item_id", "origin"]).join(t7[["F"]].rename(columns={"F": "T7"}), how="inner")
    dec = dec.rename(columns={"F": "T28"}).reset_index()
    inconsistent = int((dec.T28 < dec.T7).sum())
    dec = dec.loc[dec.T28 >= dec.T7].reset_index(drop=True)
    if os.environ.get("DEC_LIMIT"):   # smoke run only; outputs then go to a scratch name
        dec = dec.sample(int(os.environ["DEC_LIMIT"]), random_state=0).reset_index(drop=True)

    # pooled analogue pools by (category, segment, origin) for short own histories
    own = {}
    for r in dec.itertuples():
        own[r.Index] = analogues(table[(r.store_id, r.item_id)]["values"], int(r.i))
    pools = {}
    for key, g in dec.groupby(["cat", "group", "origin"]):
        mats = [own[ix] for ix in g.index if len(own[ix]) >= 6]
        if mats:
            allw = np.vstack(mats)
            pools[key] = allw[RNG.choice(len(allw), size=min(len(allw), 400), replace=False)]

    combos = [(L, R, k) for (L, R) in PAIRS for k in (KAPPAS if (L, R) == (7, 7) else (1.0,))]
    METHODS = ["D0"] + [f"{m}@{p}" for p in LEVELS for m in ("D1", "D2", "D2c")]
    n = len(dec) * len(combos) * 2 * len(METHODS)
    col = {"decision": np.empty(n, np.int32), "combo": np.empty(n, np.int8), "scen": np.empty(n, np.int8), "meth": np.empty(n, np.int8),
           "Q": np.empty(n, np.float32), "success": np.empty(n, bool), "lost_in_window": np.empty(n, np.float32),
           "end_stock": np.empty(n, np.float32), "shortage_before_arrival": np.empty(n, np.float32), "christmas_in_window": np.empty(n, bool)}
    dec_source = np.empty(len(dec), dtype=object)
    k_out = 0
    for r in dec.itertuples():
        if r.Index % 5000 == 0:
            print("decision", r.Index, "/", len(dec), flush=True)
        s = table[(r.store_id, r.item_id)]
        v = s["values"]
        i = int(r.i)
        actual = v[i:i + 28]
        point = np.concatenate([np.full(7, r.T7 / 7), np.full(21, (r.T28 - r.T7) / 21)])
        W = own[r.Index]
        source = "own"
        if len(W) < 6:
            W = pools.get((r.cat, r.group, r.origin), np.zeros((0, 28)))
            source = "pooled"
        if len(W):
            pick = W[RNG.integers(0, len(W), size=J)]
            m = pick.sum(axis=1).mean()
            paths = pick * (r.T28 / m) if m > 0 else np.zeros((J, 28))
        else:
            paths = np.tile(point, (J, 1))
            source = "none(point)"
        dec_source[r.Index] = source
        days = pd.date_range(s["start"] + pd.Timedelta(days=i), periods=28)
        xmas = (days.month == 12) & (days.day == 25)
        paths_c = paths.copy()
        paths_c[:, xmas] = 0.0
        for ci, (L, R, kappa) in enumerate(combos):
                a = L + 2
                xm = bool(xmas[a - 1:a - 1 + R].any())
                S0 = float(np.round(kappa * point[:a - 1].sum()))
                pre_act = actual[:a - 1].sum()
                stock_a = max(0.0, S0 - pre_act)
                for si, scenario in enumerate(("none", "mid")):
                    inc = None
                    if scenario == "mid":   # an existing order usable midway through the window
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
                        SS = (r_p.get((r.group, p), 1.0) - 1) * W_point
                        cand[f"D1@{p}"] = whole(max(q_point, SS - B_end_point))
                        cand[f"D2@{p}"] = whole(np.quantile(min_q(paths, S0, a, R, inc=inc), p))
                        cand[f"D2c@{p}"] = whole(np.quantile(min_q(paths_c, S0, a, R, inc=inc), p))
                    total_window = actual[a - 1:a - 1 + R].sum()
                    sba = float(max(0.0, pre_act - S0))
                    for mi, name in enumerate(METHODS):
                        Q = float(cand[name])
                        bal = stock_a + Q - cum
                        # lost units with lost sales: shortfall accumulates where the running balance dips below zero
                        lost = float(max(0.0, -bal.min()))
                        col["decision"][k_out], col["combo"][k_out], col["scen"][k_out], col["meth"][k_out] = r.Index, ci, si, mi
                        col["Q"][k_out], col["success"][k_out], col["lost_in_window"][k_out] = Q, lost <= 1e-9, lost
                        col["end_stock"][k_out] = stock_a + Q + (inc[1] if inc else 0.0) - total_window + lost
                        col["shortage_before_arrival"][k_out], col["christmas_in_window"][k_out] = sba, xm
                        k_out += 1
    assert k_out == n
    res = pd.DataFrame(col)
    cmb = pd.DataFrame(combos, columns=["L", "R", "kappa"])
    res["L"] = cmb.L.to_numpy()[res.combo]
    res["R"] = cmb.R.to_numpy()[res.combo]
    res["kappa"] = cmb.kappa.to_numpy()[res.combo]
    res["scenario"] = pd.Categorical.from_codes(res.scen, ["none", "mid"])
    res["method"] = pd.Categorical.from_codes(res.meth, METHODS)
    res["segment"] = pd.Categorical(dec.group.to_numpy()[res.decision])
    res["origin"] = dec.origin.to_numpy()[res.decision]
    res["path_source"] = pd.Categorical(dec_source[res.decision])
    res = res.drop(columns=["combo", "scen", "meth"])
    if os.environ.get("DEC_LIMIT"):
        print(res.groupby(["scenario", "method"], observed=True).success.mean())
        return
    with open(CACHE / "decisions.pkl", "wb") as f:
        pickle.dump(res, f)
    summary = res.groupby(["segment", "scenario", "L", "R", "kappa", "method"], observed=True).agg(
        decisions=("success", "size"), coverage=("success", "mean"), mean_Q=("Q", "mean"), lost_units=("lost_in_window", "mean"),
        end_stock=("end_stock", "mean"), shortage_before_arrival=("shortage_before_arrival", "mean")).reset_index()
    summary.to_csv(OUT / "us" / "decision_results.csv", index=False)

    # frozen selection: per segment x level, kappa = 1, coverage within tolerance for EVERY (L, R) pair -> lowest mean Q
    selection = {}
    blocks = ((pd.DatetimeIndex(res.origin) - pd.Timestamp("2014-11-01")).days // 28).to_numpy()
    for seg in SEGMENTS:
        for p in LEVELS:
            tol = 0.10 if seg == "rare" else 0.05
            s = summary.loc[(summary.segment == seg) & (summary.kappa == 1.0)]
            ok = []
            for m in [f"D1@{p}", f"D2@{p}", f"D2c@{p}"]:
                c = s.loc[s.method == m]
                if len(c) == 2 * len(PAIRS) and (c.coverage.sub(p).abs() <= tol).all() and c.decisions.min() >= 200:
                    ok.append((c.mean_Q.mean(), m))
            if not ok:
                selection[f"{seg}|{p}"] = {"method": None, "coverage_by_pair": {str(k): v for k, v in s.loc[s.method.isin([f"D1@{p}", f"D2@{p}", f"D2c@{p}"])]
                                           .set_index(["method", "scenario", "L", "R"]).coverage.round(3).to_dict().items()}}
                continue
            _, best = min(ok)
            mask = (res.segment == seg).to_numpy() & (res.kappa == 1.0).to_numpy() & (res.method == best).to_numpy()
            hit = res.success.to_numpy()
            ub = np.unique(blocks[mask])
            bs = []
            for _ in range(300):
                pick = RNG.choice(ub, size=len(ub))
                w = np.concatenate([np.flatnonzero(mask & (blocks == b)) for b in pick])
                bs.append(hit[w].mean())
            c = s.loc[s.method == best]
            selection[f"{seg}|{p}"] = {"method": best, "coverage_by_pair": {str(k): v for k, v in c.set_index(["scenario", "L", "R"]).coverage.round(3).to_dict().items()},
                                       "coverage_date_block_95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                                       "mean_Q_vs_D0": float(c.mean_Q.mean() / max(1e-9, s.loc[s.method == "D0"].mean_Q.mean()))}
    out = {"decisions": int(res.decision.nunique()), "inconsistent_skipped": inconsistent,
           "path_sources": res.drop_duplicates("decision").path_source.value_counts().to_dict(), "selection": selection}
    (OUT / "us" / "decision_selection.json").write_text(json.dumps(out, indent=2, default=lambda x: str(x)) + "\n")
    print(json.dumps(out, indent=1, default=str)[:5000])


if __name__ == "__main__":
    main()
