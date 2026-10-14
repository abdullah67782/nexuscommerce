"""Pakistan development experiment (dev protocol 'pakistan'): category level, this marketplace only.

Series   : daily recorded order quantities per category (15 named categories; the uncategorised group is
           reported separately and excluded from pooled metrics). Not verified fulfilled demand (no order status).
Base     : frozen production release (ml/models_v2, verified by ml/v2/registry) served exactly as the app does.
Periods  : FIT  windows within 2016-07-29..2017-06-30, daily origins   (E1 fit, exploratory)
           CAL  windows within 2017-01-01..2017-06-30, every 7 days    (U0/U1 calibration)
           SEL  windows within 2017-07-01..2017-12-31, every 7 days    (comparison)
E1       : every event occurs once in FIT -> exploratory only, never a candidate for use.
Writes outputs/pk/*.json|csv. Reads only the verified development extract (rows <= 2017-12-31).
"""
import json
import sys

import numpy as np
import pandas as pd

import data_access as D
import events as E
from e1_layer import fit_poisson
from served import Series, parity_check, served
from us_uncertainty import finite_q

sys.path[:0] = [str(D.ROOT / "ml")]
from v2.registry import load_models  # noqa: E402

OUT = D.STAGE3 / "outputs" / "pk"
START = pd.Timestamp("2016-07-01")
END = pd.Timestamp("2017-12-31")
PERIODS = {"FIT": ("2016-07-29", "2017-06-30", 1), "CAL": ("2017-01-01", "2017-06-30", 7), "SEL": ("2017-07-01", "2017-12-31", 7)}
UNCAT = "\\N"
LEVELS = (0.8, 0.9)
ALPHAS = [0.1, 1.0, 10.0]
RNG = np.random.default_rng(20261016)


def wape(F, A):
    return float(100 * np.abs(F - A).sum() / A.sum()) if A.sum() else float("nan")


def origins_in(lo, hi, step):
    lo, hi = pd.Timestamp(lo), pd.Timestamp(hi)

    def f(s, h):
        first = (lo - s.start).days
        last = (hi - s.start).days - h + 1
        return np.arange(first, last + 1, step)
    return f


def block_ci(values_fn, blocks, B=500):
    ub = np.unique(blocks)
    out = []
    for _ in range(B):
        pick = RNG.choice(ub, size=len(ub))
        idx = np.concatenate([np.flatnonzero(blocks == b) for b in pick])
        out.append(values_fn(idx))
    out = np.asarray(out, dtype=float)
    out = out[np.isfinite(out)]
    return [float(np.percentile(out, 2.5)), float(np.percentile(out, 97.5))] if len(out) else [None, None]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    df = D.pakistan_dev()
    df["category"] = df.category.fillna(UNCAT).astype(str)
    days = pd.date_range(START, END)
    daily = df.groupby(["category", "sale_date"]).quantity.sum().unstack(0).reindex(days).fillna(0.0)
    cats = sorted(daily.columns)
    named = [c for c in cats if c != UNCAT]
    series = [Series(c, days, daily[c].to_numpy()) for c in cats]
    boosters, manifest = load_models()
    cal = E.pk_calendar()

    frames = {}
    for name, (lo, hi, step) in PERIODS.items():
        rows = served(series, origins_in(lo, hi, step), boosters)
        rows["period"] = name
        rows["named"] = rows.key != UNCAT
        rows["event"] = False
        for h in (7, 28):
            m = rows.h == h
            rows.loc[m, "event"] = E.event_window_flag(rows.loc[m, "origin"], h, cal, E.PRIMARY_PK)
        frames[name] = rows
    parity = {k: float(parity_check(series, boosters, v.loc[v.method.notna() & (v.method != "none")], n=150)) for k, v in frames.items()}
    print("parity", parity, flush=True)

    # ---------- base accuracy (frozen production model, out-of-sample on this marketplace) ----------
    base = []
    for pname, rows in frames.items():
        for h in (7, 28):
            for scope, m0 in [("named_categories", rows.named), ("uncategorised", ~rows.named)]:
                s = rows.loc[m0 & (rows.h == h)]
                for kind, m in [("all", s.index), ("event", s.index[s.event]), ("non_event", s.index[~s.event])]:
                    t = s.loc[m]
                    base.append({"period": pname, "h": h, "scope": scope, "kind": kind, "windows": len(t),
                                 "wape": wape(t.F, t.A), "bias_pct": float(100 * (t.F - t.A).sum() / t.A.sum()) if t.A.sum() else None,
                                 "methods": t.method.value_counts().to_dict()})
    pd.DataFrame(base).to_csv(OUT / "base_accuracy.csv", index=False)
    per_cat = frames["SEL"].groupby(["key", "h"]).apply(lambda t: pd.Series({"windows": len(t), "wape": wape(t.F, t.A),
                                                                                "mean_actual": t.A.mean(),
                                                                                "method": t.method.mode().iat[0]}),
                                                        include_groups=False).reset_index()
    per_cat.to_csv(OUT / "sel_by_category.csv", index=False)

    # ---------- E1 exploratory (pooled over named categories; single occurrences) ----------
    fit, sel = frames["FIT"], frames["SEL"]
    fitn = fit.loc[fit.named & (fit.F >= 1)]
    seln = sel.loc[sel.named].copy()
    names = E.feature_names(cal)
    occ_fit = E.occurrences(cal, *PERIODS["FIT"][:2], E.PRIMARY_PK)

    def X_for(rows):
        X = np.zeros((len(rows), len(names)), dtype=float)
        for h in (7, 28):
            m = (rows.h == h).to_numpy()
            if m.any():
                X[m] = E.exposure(rows.loc[m, "origin"], h, cal)[0]
        return X
    Xf = X_for(fitn)
    g = fitn.assign(**{f"x{j}": Xf[:, j] for j in range(len(names))}).groupby(["origin", "h"])
    agg = g[["A", "F"] + [f"x{j}" for j in range(len(names))]].agg({"A": "sum", "F": "sum", **{f"x{j}": "first" for j in range(len(names))}})
    Xa = agg[[f"x{j}" for j in range(len(names))]].to_numpy()
    exposed = Xa.sum(axis=0) > 0
    Xs = X_for(seln)
    adjustable = (seln.F >= 1).to_numpy()
    e1_rows, effects = [], {}
    for alpha in ALPHAS:
        beta = np.zeros(len(names))
        b, res = fit_poisson(Xa[:, exposed], agg.A.to_numpy(), agg.F.to_numpy(), alpha)
        beta[exposed] = b
        Fadj = np.where(adjustable, seln.F.to_numpy() * np.exp(Xs @ beta), seln.F.to_numpy())
        rec = {"alpha": alpha, "converged": bool(res.success)}
        for h in (7, 28):
            m = (seln.h == h).to_numpy()
            ev, ne = m & seln.event.to_numpy(), m & ~seln.event.to_numpy()
            A, F0 = seln.A.to_numpy(), seln.F.to_numpy()
            rec[f"wape_event_base_{h}"], rec[f"wape_event_e1_{h}"] = wape(F0[ev], A[ev]), wape(Fadj[ev], A[ev])
            rec[f"wape_non_event_base_{h}"], rec[f"wape_non_event_e1_{h}"] = wape(F0[ne], A[ne]), wape(Fadj[ne], A[ne])
            rec[f"rel_event_improvement_{h}"] = (rec[f"wape_event_base_{h}"] - rec[f"wape_event_e1_{h}"]) / rec[f"wape_event_base_{h}"]
        e1_rows.append(rec)
        effects[alpha] = {n: float(np.exp(bb)) for n, bb in zip(names, beta) if bb != 0}
        print("E1", alpha, {k: round(v, 4) for k, v in rec.items() if k.startswith("rel")}, flush=True)
    pd.DataFrame(e1_rows).to_csv(OUT / "e1_exploratory.csv", index=False)

    # ---------- U0 / U1 coverage (calibrated on CAL, evaluated on SEL; named categories) ----------
    calr = frames["CAL"].loc[frames["CAL"].named & frames["CAL"].method.notna()]
    selr = sel.loc[sel.named & sel.method.notna()].reset_index(drop=True)
    blocks = ((selr.origin - pd.Timestamp("2017-07-01")).dt.days // 28).to_numpy()
    unc, unc_sel = [], {}
    for h in (7, 28):
        for p in LEVELS:
            for seg_name, seg_filter in [("pooled", None)] + [(s, s) for s in sorted(selr.group.unique())]:
                c = calr.loc[(calr.h == h) & ((calr.group == seg_filter) if seg_filter else True)]
                s_mask = ((selr.h == h) & ((selr.group == seg_filter) if seg_filter else True)).to_numpy()
                if len(c) == 0 or not s_mask.any():
                    continue
                Fs, As = selr.F.to_numpy(), selr.A.to_numpy()
                ups = {"U0": np.maximum((Fs + 1) * finite_q((c.A + 1) / (c.F + 1), p) - 1, 0),
                       "U1": np.maximum(Fs + finite_q((c.A - c.F) / np.sqrt(c.F + 1), p) * np.sqrt(Fs + 1), 0)}
                for meth, up in ups.items():
                    hit = As <= up
                    rec = {"h": h, "p": p, "segment": seg_name, "method": meth, "cal_windows": len(c), "sel_windows": int(s_mask.sum()),
                           "categories": int(selr.loc[s_mask, "key"].nunique()),
                           "coverage_all": float(hit[s_mask].mean()),
                           "coverage_event": float(hit[s_mask & selr.event.to_numpy()].mean()) if (s_mask & selr.event.to_numpy()).any() else None,
                           "coverage_non_event": float(hit[s_mask & ~selr.event.to_numpy()].mean()) if (s_mask & ~selr.event.to_numpy()).any() else None,
                           "n_event": int((s_mask & selr.event.to_numpy()).sum()),
                           "mean_rel_width": float(np.mean((up[s_mask] - Fs[s_mask]) / (Fs[s_mask] + 1))),
                           "coverage_date_block_95": block_ci(lambda idx: hit[idx][s_mask[idx]].mean() if s_mask[idx].any() else np.nan, blocks)}
                    unc.append(rec)
    ures = pd.DataFrame(unc)
    ures.to_csv(OUT / "uncertainty_results.csv", index=False)
    for h in (7, 28):
        for p in LEVELS:
            c = ures.loc[(ures.h == h) & (ures.p == p) & (ures.segment == "pooled")]
            ok = c.loc[(c.coverage_event.sub(p).abs() <= 0.05) & (c.coverage_non_event.sub(p).abs() <= 0.05)]
            small = c.sel_windows.max() < 200
            unc_sel[f"pooled|{h}|{p}"] = ({"method": None, "reason": "insufficient sample (< 200 windows)" if small else "no candidate within tolerance"}
                                          if ok.empty or small else
                                          {"method": ok.sort_values("mean_rel_width").iloc[0].method,
                                           **ok.sort_values("mean_rel_width").iloc[0][["coverage_all", "coverage_event", "coverage_non_event",
                                                                                         "mean_rel_width", "sel_windows"]].to_dict()})

    result = {
        "scope": "category level, this marketplace only; target = recorded order quantities (no order status); no SKU advice",
        "categories": {"named": named, "uncategorised_reported_separately": UNCAT in cats},
        "rows": int(len(df)), "date_range": [str(df.sale_date.min().date()), str(df.sale_date.max().date())],
        "base_model": manifest.get("release", manifest.get("version")), "parity_max_abs_units": parity,
        "windows": {k: {str(h): int(((v.h == h) & v.named).sum()) for h in (7, 28)} for k, v in frames.items()},
        "fit_occurrences_primary": occ_fit, "sel_occurrences_primary": E.occurrences(cal, *PERIODS["SEL"][:2], E.PRIMARY_PK),
        "e1_exploratory": {"label": "EXPLORATORY: every effect estimated from a single occurrence; not a candidate",
                           "results": e1_rows, "multipliers_per_day_alpha_1": effects[1.0]},
        "uncertainty_selection_pooled": unc_sel,
        "note_cal_fit_overlap": "CAL (2017-01..06) lies inside the E1 FIT range; U0/U1 calibrate base-forecast residuals and do not use E1",
    }
    (OUT / "pk_results.json").write_text(json.dumps(result, indent=2, default=lambda x: x.item() if hasattr(x, "item") else str(x)) + "\n")
    print(json.dumps({k: result[k] for k in ("windows", "parity_max_abs_units", "uncertainty_selection_pooled")}, indent=1, default=str))


if __name__ == "__main__":
    main()
