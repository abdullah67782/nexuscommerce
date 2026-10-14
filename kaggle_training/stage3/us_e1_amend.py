"""Amendment A1 candidates for the US event layer (see outputs/dev_protocol_amendment_A1.json).
Same data, metrics and selection rule as us_e1.py; original candidates stay in the comparison."""
import json
import pickle

import numpy as np
import pandas as pd

import events as E
from e1_layer import fit_poisson_weighted
from us_e1 import ALPHAS, CACHE, FIT_RANGE, OUT, SEL_RANGE, _weighted_improvement, bias, build, wape

RNG = np.random.default_rng(20261014)
CLOSURE = "Christmas"


def closed_days(origins, h, cal):
    o = pd.DatetimeIndex(origins).values.astype("datetime64[D]").astype(np.int64)
    c = np.zeros(len(o))
    for d in cal.loc[cal.event == CLOSURE, "date"]:
        dd = np.int64(np.datetime64(d, "D").astype(np.int64))
        c += ((o <= dd) & (dd <= o + h - 1))
    return c


def main():
    cal = E.us_calendar()
    names = E.feature_names(cal)
    occ = cal.loc[(cal.date >= FIT_RANGE[0]) & (cal.date <= FIT_RANGE[1])].groupby("event").date.nunique()
    usable = set(occ.loc[occ >= 2].index)
    keep = np.array([n.split("|")[0] in usable and n != f"{CLOSURE}|d0" for n in names])
    fit = pd.concat([pickle.loads((CACHE / f"{p}.pkl").read_bytes())["agg"] for p in ("FIT_A", "FIT_B")], ignore_index=True)
    sel = pickle.loads((CACHE / "SEL.pkl").read_bytes())["rows"]
    sel = sel.loc[sel.method.notna()].copy()
    cats, stores = sorted(fit.cat.unique()), sorted(fit.store_id.unique())

    def xmap(origins):
        u = pd.DatetimeIndex(sorted(pd.unique(origins)))
        return {h: (u, E.exposure(u, h, cal)[0][:, keep]) for h in (7, 28)}
    xs_fit, xs_sel = xmap(fit.origin), xmap(sel.origin)
    sel["event"] = False
    sel["closed"] = 0.0
    for h in (7, 28):
        m = sel.h == h
        sel.loc[m, "event"] = E.event_window_flag(sel.loc[m, "origin"], h, cal, E.PRIMARY_US)
        sel.loc[m, "closed"] = closed_days(sel.loc[m, "origin"], h, cal)
    # closure applied to fit rows too, so E1w learns the remaining effects on top of it (E1cw)
    fit_closed = np.zeros(len(fit))
    for h in (7, 28):
        m = (fit.h == h).to_numpy()
        fit_closed[m] = closed_days(fit.loc[m, "origin"], h, cal)
    fit = fit.assign(F_closure=fit.F * (fit.h - fit_closed) / fit.h)
    adjustable = (sel.F >= 1.0).to_numpy()
    closure_mult = ((sel.h - sel.closed) / sel.h).to_numpy()

    def metrics(Fadj, label, **extra):
        rec = {"candidate": label, **extra}
        A = sel.A.to_numpy()
        for h in (7, 28):
            m = (sel.h == h).to_numpy()
            ev, ne = m & sel.event.to_numpy(), m & ~sel.event.to_numpy()
            b = wape(sel.F.to_numpy()[ev], A[ev])
            rec[f"wape_all_{h}"] = wape(Fadj[m], A[m])
            rec[f"wape_event_{h}"] = wape(Fadj[ev], A[ev])
            rec[f"wape_non_event_{h}"] = wape(Fadj[ne], A[ne])
            rec[f"bias_event_{h}"] = bias(Fadj[ev], A[ev])
            rec[f"rel_event_improvement_{h}"] = (b - rec[f"wape_event_{h}"]) / b
        rec["score"] = (rec["rel_event_improvement_7"] + rec["rel_event_improvement_28"]) / 2
        return rec

    F = sel.F.to_numpy()
    rows, adj = [], {}
    Fc = np.where(adjustable, F * closure_mult, F)
    rows.append(metrics(Fc, "E1c"))
    adj["E1c"] = Fc
    for level in ["pooled", "pooled+category"]:
        keys = ["origin", "h"] + (["cat"] if level != "pooled" else [])
        for closure in (False, True):
            col = "F_closure" if closure else "F"
            g = fit.groupby(keys, observed=True)[["A", col]].sum().reset_index().rename(columns={col: "Fx"})
            g["cat"] = g["cat"] if "cat" in g else cats[0]
            g["store_id"] = stores[0]
            Xf = build(g, xs_fit, level, cats, stores)
            Xs = build(sel, xs_sel, level, cats, stores)
            for alpha in ALPHAS:
                beta, res = fit_poisson_weighted(Xf, g.A.to_numpy(), g.Fx.to_numpy(), alpha)
                base_F = Fc if closure else F
                Fadj = np.where(adjustable, base_F * np.exp(Xs @ beta), F)
                name = ("E1cw" if closure else "E1w")
                rows.append(metrics(Fadj, name, level=level, alpha=alpha, converged=bool(res.success)))
                adj[(name, level, alpha)] = (Fadj, beta)
                print(name, level, alpha, round(rows[-1]["score"], 4), flush=True)
    table = pd.DataFrame(rows)
    original = pd.read_csv(OUT / "us" / "e1_candidates.csv").assign(candidate="E1 (original)")
    table.to_csv(OUT / "us" / "e1_amendment_candidates.csv", index=False)
    allc = pd.concat([original, table], ignore_index=True)
    best = allc.sort_values("score", ascending=False).iloc[0]
    key = best.candidate if best.candidate in ("E1c",) else (best.candidate, best.level, best.alpha)
    Fbest = adj[key] if isinstance(adj.get(key), np.ndarray) else adj[key][0]
    dates = pd.DatetimeIndex(sel.origin)
    blocks = ((dates - pd.Timestamp(SEL_RANGE[0])).days // 28).to_numpy()
    items = sel.item_id.to_numpy()
    ub, ui = np.unique(blocks), np.unique(items)
    bb, bi = {7: [], 28: []}, {7: [], 28: []}
    for _ in range(500):
        w = np.zeros(len(sel), dtype=int)
        for b in RNG.choice(ub, size=len(ub)):
            w += blocks == b
        rb = _weighted_improvement(sel, Fbest, np.repeat(np.arange(len(sel)), w))
        cnt = pd.Series(RNG.choice(ui, size=len(ui))).value_counts()
        wi = pd.Series(items).map(cnt).fillna(0).to_numpy().astype(int)
        ri = _weighted_improvement(sel, Fbest, np.repeat(np.arange(len(sel)), wi))
        for h in (7, 28):
            bb[h].append(rb[h]); bi[h].append(ri[h])
    ci = {h: {"date_block_95": [float(np.percentile(bb[h], 2.5)), float(np.percentile(bb[h], 97.5))],
              "product_cluster_95": [float(np.percentile(bi[h], 2.5)), float(np.percentile(bi[h], 97.5))]} for h in (7, 28)}
    # per-primary-event descriptive breakdown for the selected candidate
    per_event = []
    for ev in E.PRIMARY_US:
        for h in (7, 28):
            m = (sel.h == h).to_numpy() & E.event_window_flag(sel.origin, h, cal, [ev])
            if m.sum():
                A = sel.A.to_numpy()[m]
                per_event.append({"event": ev, "h": h, "windows": int(m.sum()), "wape_base": wape(F[m], A), "wape_selected": wape(Fbest[m], A)})
    result = {"selected": {k: (v.item() if hasattr(v, "item") else v) for k, v in best.to_dict().items() if pd.notna(v)},
              "selected_intervals": ci, "per_event_selected": per_event,
              "second_look_note": "SEL was already seen for the original candidates; amendment candidates are a second look."}
    (OUT / "us" / "e1_amendment_results.json").write_text(json.dumps(result, indent=2, default=float) + "\n")
    if not isinstance(adj.get(key), np.ndarray):
        with open(CACHE / "e1_amend_selected.pkl", "wb") as f:
            pickle.dump({"key": key, "beta": adj[key][1], "keep": keep, "names": names, "cats": cats}, f)
    print(json.dumps(result["selected"], default=float))
    print(json.dumps(ci))


if __name__ == "__main__":
    main()
