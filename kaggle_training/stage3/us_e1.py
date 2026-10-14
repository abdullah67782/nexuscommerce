"""US development experiment for the event layer E1 (fit on FIT_A+FIT_B, compare on SEL).

Writes outputs/us/e1_results.json, e1_candidates.csv, e1_selected_effects.csv.
Nothing is fitted on SEL; the selection rule is the frozen one.
"""
import json
import pickle

import numpy as np
import pandas as pd

import data_access as D
import events as E
from e1_layer import design, fit_poisson

OUT = D.STAGE3 / "outputs"
CACHE = OUT / "cache"
FIT_RANGE = ("2012-06-01", "2014-05-31")
SEL_RANGE = ("2014-11-01", "2015-05-31")
LEVELS = ["pooled", "pooled+category", "pooled+category+store"]
ALPHAS = [0.1, 1.0, 10.0]
SCALE = 0.5
RNG = np.random.default_rng(20261013)


def wape(F, A):
    return float(100 * np.abs(F - A).sum() / A.sum()) if A.sum() else float("nan")


def bias(F, A):
    return float(100 * (F - A).sum() / A.sum()) if A.sum() else float("nan")


def cells_for(frame, level, cats, stores):
    c = frame.cat.map({k: i for i, k in enumerate(cats)}).to_numpy()
    s = frame.store_id.map({k: i for i, k in enumerate(stores)}).to_numpy()
    return c, s


def build(frame, xs, level, cats, stores):
    """frame rows with columns origin, h; xs: dict h -> (origin index map, X)."""
    X = np.vstack([xs[h][1][xs[h][0].get_indexer(frame.loc[frame.h == h, "origin"])] for h in (7, 28)])
    order = np.concatenate([np.flatnonzero(frame.h.to_numpy() == h) for h in (7, 28)])
    inv = np.empty_like(order)
    inv[order] = np.arange(len(order))
    X = X[inv]
    if level == "pooled":
        return X
    c, s = cells_for(frame, level, cats, stores)
    parts = [X] + [np.where((c == k)[:, None], X * SCALE, 0.0) for k in range(len(cats))]
    if level == "pooled+category+store":
        parts += [np.where((s == k)[:, None], X * SCALE, 0.0) for k in range(len(stores))]
    return np.hstack(parts)


def main():
    cal = E.us_calendar()
    names = E.feature_names(cal)
    occ_fit = cal.loc[(cal.date >= FIT_RANGE[0]) & (cal.date <= FIT_RANGE[1])].groupby("event").date.nunique()
    usable_events = sorted(occ_fit.loc[occ_fit >= 2].index)
    keep_cols = np.array([n.split("|")[0] in usable_events for n in names])

    fit = pd.concat([pickle.loads((CACHE / f"{p}.pkl").read_bytes())["agg"] for p in ("FIT_A", "FIT_B")], ignore_index=True)
    sel = pickle.loads((CACHE / "SEL.pkl").read_bytes())["rows"]
    sel = sel.loc[sel.method.notna()].copy()
    cats = sorted(fit.cat.unique())
    stores = sorted(fit.store_id.unique())

    def xmap(origins):
        out = {}
        for h in (7, 28):
            u = pd.DatetimeIndex(sorted(pd.unique(origins)))
            X, _ = E.exposure(u, h, cal)
            out[h] = (u, X[:, keep_cols])
        return out
    xs_fit = xmap(fit.origin)
    xs_sel = xmap(sel.origin)

    sel["event"] = False
    for h in (7, 28):
        m = sel.h == h
        sel.loc[m, "event"] = E.event_window_flag(sel.loc[m, "origin"], h, cal, E.PRIMARY_US)
    adjustable = sel.F >= 1.0

    base = {}
    for h in (7, 28):
        s = sel.loc[sel.h == h]
        base[h] = {"all": wape(s.F, s.A), "event": wape(s.F[s.event], s.A[s.event]), "non_event": wape(s.F[~s.event], s.A[~s.event]),
                   "bias_event": bias(s.F[s.event], s.A[s.event]), "bias_all": bias(s.F, s.A)}

    rows, fitted = [], {}
    for level in LEVELS:
        agg_keys = ["origin", "h"] + (["cat"] if level == "pooled+category" else ["cat", "store_id"] if level != "pooled" else [])
        g = fit.groupby(agg_keys, observed=True)[["A", "F"]].sum().reset_index()
        if "cat" not in g:
            g["cat"] = cats[0]
        if "store_id" not in g:
            g["store_id"] = stores[0]
        Xf = build(g, xs_fit, level, cats, stores)
        Xs = build(sel, xs_sel, level, cats, stores)
        for alpha in ALPHAS:
            beta, res = fit_poisson(Xf, g.A.to_numpy(), g.F.to_numpy(), alpha)
            mult = np.where(adjustable, np.exp(Xs @ beta), 1.0)
            Fadj = sel.F.to_numpy() * mult
            rec = {"level": level, "alpha": alpha, "converged": bool(res.success), "parameters": int(len(beta))}
            for h in (7, 28):
                m = (sel.h == h).to_numpy()
                ev, ne = m & sel.event.to_numpy(), m & ~sel.event.to_numpy()
                A = sel.A.to_numpy()
                rec[f"wape_all_{h}"] = wape(Fadj[m], A[m])
                rec[f"wape_event_{h}"] = wape(Fadj[ev], A[ev])
                rec[f"wape_non_event_{h}"] = wape(Fadj[ne], A[ne])
                rec[f"bias_event_{h}"] = bias(Fadj[ev], A[ev])
                rec[f"rel_event_improvement_{h}"] = (base[h]["event"] - rec[f"wape_event_{h}"]) / base[h]["event"]
            rec["score"] = (rec["rel_event_improvement_7"] + rec["rel_event_improvement_28"]) / 2
            rows.append(rec)
            fitted[(level, alpha)] = (beta, Fadj)
            print(level, alpha, round(rec["score"], 4), flush=True)
    table = pd.DataFrame(rows)
    order = {lv: i for i, lv in enumerate(LEVELS)}
    table["_simple"] = table.level.map(order)
    best = table.sort_values(["score", "_simple", "alpha"], ascending=[False, True, False]).iloc[0]
    beta, Fadj = fitted[(best.level, best.alpha)]

    # dependence-aware intervals for the selected candidate's event-window improvement
    def improvement(idx):
        out = {}
        for h in (7, 28):
            m = idx & (sel.h == h).to_numpy() & sel.event.to_numpy()
            A, F0, F1 = sel.A.to_numpy()[m], sel.F.to_numpy()[m], Fadj[m]
            out[h] = (wape(F0, A) - wape(F1, A)) / wape(F0, A)
        return out
    dates = sel.origin.to_numpy()
    blocks = ((pd.DatetimeIndex(dates) - pd.Timestamp(SEL_RANGE[0])).days // 28).to_numpy()
    items = sel.item_id.to_numpy()
    ub, ui = np.unique(blocks), np.unique(items)
    boot_b, boot_i = {7: [], 28: []}, {7: [], 28: []}
    for _ in range(500):
        pick = RNG.choice(ub, size=len(ub), replace=True)
        w = np.zeros(len(sel))
        for b in pick:
            w += blocks == b
        idx_rows = np.repeat(np.arange(len(sel)), w.astype(int))
        res_b = _weighted_improvement(sel, Fadj, idx_rows)
        pick_i = RNG.choice(ui, size=len(ui), replace=True)
        counts = pd.Series(pick_i).value_counts()
        wi = pd.Series(items).map(counts).fillna(0).to_numpy().astype(int)
        res_i = _weighted_improvement(sel, Fadj, np.repeat(np.arange(len(sel)), wi))
        for h in (7, 28):
            boot_b[h].append(res_b[h])
            boot_i[h].append(res_i[h])
    ci = {h: {"date_block_95": [float(np.percentile(boot_b[h], 2.5)), float(np.percentile(boot_b[h], 97.5))],
              "product_cluster_95": [float(np.percentile(boot_i[h], 2.5)), float(np.percentile(boot_i[h], 97.5))]}
          for h in (7, 28)}

    by_group = []
    for (h, grp), s in sel.assign(Fadj=Fadj).groupby(["h", "group"]):
        for kind, m in [("event", s.event), ("non_event", ~s.event)]:
            by_group.append({"h": h, "group": grp, "kind": kind, "windows": int(m.sum()), "series": int(s.loc[m, "item_id"].nunique()),
                             "wape_base": wape(s.F[m], s.A[m]), "wape_e1": wape(s.Fadj[m], s.A[m])})
    effects = pd.DataFrame({"feature": np.array(names)[keep_cols], "beta_pooled_per_day": beta[:keep_cols.sum()]})
    effects["multiplier_per_day"] = np.exp(effects.beta_pooled_per_day)
    (OUT / "us").mkdir(exist_ok=True)
    table.drop(columns=["_simple"]).to_csv(OUT / "us" / "e1_candidates.csv", index=False)
    effects.to_csv(OUT / "us" / "e1_selected_effects.csv", index=False)
    pd.DataFrame(by_group).to_csv(OUT / "us" / "e1_by_group.csv", index=False)
    sel_counts = {h: {"windows": int((sel.h == h).sum()), "event_windows": int(((sel.h == h) & sel.event).sum()),
                      "series": int(sel.loc[sel.h == h, "item_id"].astype(str).str.cat(sel.loc[sel.h == h, "store_id"].astype(str)).nunique())}
                  for h in (7, 28)}
    result = {
        "base_r14": base, "selected": {k: (v.item() if hasattr(v, "item") else v) for k, v in best.drop("_simple").to_dict().items()},
        "selected_intervals": ci, "usable_events": usable_events,
        "fit_occurrences": E.occurrences(cal, *FIT_RANGE), "sel_occurrences_primary": E.occurrences(cal, *SEL_RANGE, E.PRIMARY_US),
        "sel_counts": sel_counts, "rows_not_adjusted_F_below_1": int((~adjustable).sum()),
        "windows_with_more_than_one_event": {h: int((((xs_sel[h][1] > 0).reshape(len(xs_sel[h][0]), -1)
                                                      .reshape(len(xs_sel[h][0]), -1, 5).any(axis=2)).sum(axis=1) > 1).sum()) for h in (7, 28)},
    }
    (OUT / "us" / "e1_results.json").write_text(json.dumps(result, indent=2, default=float) + "\n")
    with open(CACHE / "e1_selected.pkl", "wb") as f:
        pickle.dump({"level": best.level, "alpha": float(best.alpha), "beta": beta, "names": list(np.array(names)[keep_cols]),
                     "cats": cats, "stores": stores, "scale": SCALE}, f)
    print(json.dumps(result["selected"], default=float))


def _weighted_improvement(sel, Fadj, rows_idx):
    out = {}
    s = sel.iloc[rows_idx]
    F1 = Fadj[rows_idx]
    for h in (7, 28):
        m = ((s.h == h) & s.event).to_numpy()
        A, F0 = s.A.to_numpy()[m], s.F.to_numpy()[m]
        w0 = np.abs(F0 - A).sum()
        out[h] = (w0 - np.abs(F1[m] - A).sum()) / w0 if w0 else float("nan")
    return out


if __name__ == "__main__":
    main()
