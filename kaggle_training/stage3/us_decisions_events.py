"""Supplementary breakdown of the decision track (no new selection): coverage of the frozen selections in
decision windows that overlap a primary US event ([d-7, d+3]) versus other windows, plus kappa sensitivity.
Reads cache/decisions.pkl and us/decision_selection.json; writes us/decision_event_breakdown.csv."""
import json
import pickle

import numpy as np
import pandas as pd

import events as E
from us_backtest import CACHE, OUT


def main():
    res = pickle.loads((CACHE / "decisions.pkl").read_bytes())
    sel = json.loads((OUT / "us" / "decision_selection.json").read_text())["selection"]
    cal = E.us_calendar()
    res["window_start"] = pd.DatetimeIndex(res.origin) + pd.to_timedelta(res.L + 1, unit="D")
    res["event"] = False
    for R in res.R.unique():
        m = (res.R == R).to_numpy()
        res.loc[m, "event"] = E.event_window_flag(res.loc[m, "window_start"], int(R), cal, E.PRIMARY_US)
    rows = []
    for key, v in sel.items():
        seg, p = key.split("|")
        for m in ([v["method"]] if v["method"] else []) + ["D0", f"D2c@{p}", f"D1@{p}"]:
            t = res.loc[(res.segment == seg) & (res.method == m)]
            for kappa, tk in t.groupby("kappa"):
                for kind, mm in [("event", tk.event), ("non_event", ~tk.event), ("christmas_in_window", tk.christmas_in_window)]:
                    rows.append({"segment": seg, "p": float(p), "method": m, "selected": m == v["method"], "kappa": kappa, "kind": kind,
                                 "decisions": int(mm.sum()), "coverage": float(tk.success[mm].mean()) if mm.any() else None,
                                 "mean_Q": float(tk.Q[mm].mean()) if mm.any() else None})
    out = pd.DataFrame(rows).drop_duplicates(["segment", "p", "method", "kappa", "kind"])
    out.to_csv(OUT / "us" / "decision_event_breakdown.csv", index=False)
    print(out.loc[out.selected & (out.kappa == 1.0)].round(3).to_string())


if __name__ == "__main__":
    main()
