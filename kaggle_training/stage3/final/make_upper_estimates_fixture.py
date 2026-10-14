"""Artifact-to-API parity fixture for upper-estimates-1 (development data only).

For real M5 DEVELOPMENT series (development_extra products, guarded loader, days <= 2015-10-31) and several
origins each, computes every approved cell's upper estimate with the FROZEN research code that produced the
final evaluation (common.serve / common.totals_uppers / common.u3_uppers, u2_artifacts, the frozen calibration
and the selected boosters), and writes the inputs and expected values to ml/tests/fixtures/upper_estimates_fixture.json.

The application's service (ml/v2/upper_estimates.py) must reproduce these values in the app runtime:
U0/U1/U2 within 1e-9 units, U3 exactly (same seeded draws). No reserved product and no final-period day is read.

    python make_upper_estimates_fixture.py [--products 60]
"""
import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402
from calibrate import selected_u2  # noqa: E402

D = C.D
ROOT = C.STAGE3.parents[1]
sys.path.insert(0, str(ROOT / "ml"))
from v2.upper_estimates import u3_seed  # noqa: E402  (seed derivation only; the draws use common.u3_uppers)

CAL_DIR = C.STAGE3 / "outputs" / "final_prep" / "verification" / "laptop_run" / "calibration"
ORIGINS = ["2015-05-04", "2015-07-13", "2015-09-21", "2015-10-31"]
SELECTED = {k: v for k, v in json.loads((C.STAGE3 / "outputs" / "final_protocol.json").read_text())["selections"]["totals_uncertainty"].items()
            if k.split("|")[0] in ("regular", "occasional", "rare")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--products", type=int, default=60)
    ap.add_argument("--out", default=str(ROOT / "ml" / "tests" / "fixtures" / "upper_estimates_fixture.json"))
    a = ap.parse_args()
    res = json.loads(D.RESERVATION.read_text())
    products = sorted(res["development_extra_products"])[: a.products]
    long = D.m5_daily(products, D.DEV_END_US)
    launches = D.m5_launch_dates(products)
    long = long.merge(launches, on=["store_id", "item_id"]).query("date >= launch_date")
    calib = json.loads((CAL_DIR / "calibration_us.json").read_text())
    u2b = selected_u2()
    boosters, manifest = C.production_boosters()
    cases, per_cell = [], {k: 0 for k in SELECTED}
    rng_pick = np.random.default_rng(7)
    groups = list(long.groupby(["store_id", "item_id"], sort=True))
    for gi in rng_pick.permutation(len(groups)):
        (store, item), g = groups[gi]
        g = g.sort_values("date")
        v_all = g.sales.to_numpy(dtype=float)
        start = g.date.iloc[0]
        for o in ORIGINS:
            i = int((pd.Timestamp(o) - start).days) + (1 if o == ORIGINS[-1] else 0)
            if i < 180 or i > len(v_all):
                continue
            hist = v_all[:i]
            key = f"{store}|{item}|{o}"
            table = {key: {"start": start, "values": np.concatenate([hist, np.zeros(28)]), "cat": g.cat_id.iloc[0]}}
            rows, X, _ = C.serve(table, lambda s, h, i=i: np.array([i]), boosters, parity_rows=2)
            if len(rows) != 2:
                continue
            group = rows.group.iloc[0]
            if group not in ("regular", "occasional", "rare"):
                continue
            up = C.totals_uppers(rows, X, table, calib, u2b, np.random.default_rng(0))
            expected = {}
            for r in rows.itertuples():
                for p in C.LEVELS:
                    cell = f"{group}|{r.h}|{p}"
                    m = SELECTED[cell]
                    if m == "U3":
                        sub = rows.loc[[r.Index]]
                        val = C.u3_uppers(sub, table, np.random.default_rng(u3_seed(start.date(), hist, int(r.h))))[p][0]
                    else:
                        val = up[(m, p)][r.Index]
                    expected[cell] = {"method": m, "upper": float(val), "F": float(r.F)}
                    per_cell[cell] += 1
            cases.append({"id": key, "start": str(start.date()), "quantities": [float(x) for x in hist], "group": group,
                          "expected": expected})
        if len(cases) >= 120 and min(per_cell.values()) >= 6:
            break
    out = {"made_with": {"protocol_sha256": D.sha256(C.STAGE3 / "outputs" / "final_protocol.json"),
                         "release": manifest.get("release"), "products": "development_extra (guarded, <= 2015-10-31)",
                         "numpy": np.__version__, "pandas": pd.__version__},
           "per_cell": per_cell, "cases": cases}
    Path(a.out).write_text(json.dumps(out) + "\n")
    print(json.dumps({"cases": len(cases), "per_cell": per_cell}, indent=1))


if __name__ == "__main__":
    main()
