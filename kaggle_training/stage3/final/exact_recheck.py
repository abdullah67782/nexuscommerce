"""Exact (unrounded) recheck of every development selection, the kappa-robust amendment A2 and the
dev-anchored excess-stock caps. Development data only (outputs/cache). Writes outputs/final_prep/exact_recheck.json.

Nothing is re-selected by convenience: the original development selections are reproduced with exact
arithmetic and kept on record; A2 is applied as a disclosed amendment.
"""
import json
import pickle
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

OUT = C.STAGE3 / "outputs"
CACHE = OUT / "cache"
PREP = OUT / "final_prep"


def totals_recheck():
    cal_events = C.E.us_calendar()
    sel = pickle.loads((CACHE / "SEL.pkl").read_bytes())["rows"]
    sel = sel.loc[sel.method.notna()].copy()
    ref = pickle.loads((CACHE / "sel_uppers.pkl").read_bytes())
    sel = C.flag_events(sel, cal_events, C.E.PRIMARY_US)
    keys = (sel.store_id.astype(str) + "|" + sel.item_id.astype(str)).to_numpy()
    A, F, ev = sel.A.to_numpy(), sel.F.to_numpy(), sel.event.to_numpy()
    frozen = json.loads((OUT / "us" / "uncertainty_selection.json").read_text())
    out, mismatches = {}, []
    for seg in C.SEGMENTS:
        for h in C.HORIZONS:
            for p in C.LEVELS:
                tol = C.tolerance(seg)
                cands = []
                n_max = 0
                for meth in ("U0", "U1", "U2", "U3"):
                    up = ref["uppers"][(meth, p)]
                    m = (sel.group == seg).to_numpy() & (sel.h == h).to_numpy() & np.isfinite(up)
                    if not m.any():
                        continue
                    n_max = max(n_max, int(m.sum()))
                    hit = A <= up
                    ne, ke = int((m & ev).sum()), int(hit[m & ev].sum())
                    nn, kn = int((m & ~ev).sum()), int(hit[m & ~ev].sum())
                    width = float(np.mean((up[m] - F[m]) / (F[m] + 1)))
                    series = int(pd.unique(keys[m]).size)
                    ok = C.within_tolerance(ke, ne, p, tol) and C.within_tolerance(kn, nn, p, tol)
                    cands.append({"method": meth, "event": [ke, ne], "non_event": [kn, nn], "series": series,
                                  "mean_rel_width": width, "within_both": ok})
                small = n_max < C.MIN_WINDOWS
                passing = [c for c in cands if c["within_both"]]
                choice = None if (small or not passing) else min(passing, key=lambda c: c["mean_rel_width"])["method"]
                key = f"{seg}|{h}|{p}"
                out[key] = {"exact_choice": choice, "frozen_dev_choice": frozen[key]["method"], "candidates": cands,
                            "series_requirement_met": None if choice is None else next(c for c in cands if c["method"] == choice)["series"] >= C.MIN_SERIES}
                if choice != frozen[key]["method"]:
                    mismatches.append(key)
    return out, mismatches


def decision_recheck():
    res = pickle.loads((CACHE / "decisions.pkl").read_bytes())
    res = res.assign(Q=res.Q.round().astype(np.int64), lost=res.lost_in_window.round().astype(np.int64),
                     end_stock=res.end_stock.round().astype(np.int64),
                     shortage_before_arrival=res.shortage_before_arrival.round().astype(np.int64))
    res["segment"] = res.segment.astype(str)
    res["method"] = res.method.astype(str)
    res["scenario"] = res.scenario.astype(str)
    cells = C.decision_cells(res)
    frozen = json.loads((OUT / "us" / "decision_selection.json").read_text())["selection"]
    a0 = C.select_decisions(cells, "A0")
    a2 = C.select_decisions(cells, "A2")
    mism = [k for k in a0 if a0[k] != frozen[k]["method"]]
    caps = {}
    for key, m in a2.items():
        if m is None:
            continue
        seg, p = key.split("|")
        worst, worst_cell = None, None
        for x in cells.loc[(cells.segment == seg) & (cells.method == m)].itertuples():
            d0 = cells.loc[(cells.segment == seg) & (cells.method == "D0") & (cells.scenario == x.scenario) & (cells.L == x.L)
                           & (cells.R == x.R) & (cells.kappa == x.kappa)].iloc[0]
            ratio, avoided, excess = C.excess_ratio(x, d0)
            if ratio is None:
                raise SystemExit(f"{key}: a development cell avoided no shortage; the cap is undefined")
            if worst is None or ratio > worst:
                worst, worst_cell = ratio, {"scenario": x.scenario, "L": int(x.L), "R": int(x.R), "kappa": float(x.kappa),
                                            "avoided_per_decision": C.fstr(avoided), "excess_per_decision": C.fstr(excess)}
        cap = Fraction(5, 4) * worst
        caps[key] = {"method": m, "dev_worst_ratio": C.fstr(worst), "dev_worst_cell": worst_cell, "cap": C.fstr(cap)}
    table = []
    for x in cells.itertuples():
        table.append({"segment": x.segment, "scenario": x.scenario, "L": int(x.L), "R": int(x.R), "kappa": float(x.kappa),
                      "method": x.method, "decisions": int(x.decisions), "hits": int(x.hits), "sum_Q": int(x.sum_Q),
                      "sum_lost": int(x.sum_lost), "sum_end": int(x.sum_end), "sum_sba": int(x.sum_sba)})
    return {"A0_original_exact": a0, "A0_matches_frozen_dev": not mism, "A0_mismatches": mism,
            "A2_kappa_robust_exact": a2, "caps": caps}, table


def main():
    PREP.mkdir(parents=True, exist_ok=True)
    totals, tmis = totals_recheck()
    dec, table = decision_recheck()
    out = {"totals_uncertainty": totals, "totals_matches_frozen_dev": not tmis, "totals_mismatches": tmis, "decisions": dec}
    (PREP / "exact_recheck.json").write_text(json.dumps(out, indent=2) + "\n")
    pd.DataFrame(table).to_csv(PREP / "dev_decision_cells_exact.csv", index=False)
    print("totals match frozen:", not tmis, tmis)
    print("decisions A0 match frozen:", dec["A0_matches_frozen_dev"], dec["A0_mismatches"])
    print("A2:", dec["A2_kappa_robust_exact"])
    print("caps:", {k: (v["method"], v["dev_worst_ratio"]["value"], v["cap"]["value"]) for k, v in dec["caps"].items()})


if __name__ == "__main__":
    main()
