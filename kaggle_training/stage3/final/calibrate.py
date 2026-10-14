"""Final calibration (frozen protocol nexus-stage3-final-protocol-v1, section 'calibration').

US : frozen release nexus-v2-shared-20261008 served exactly, on DEVELOPMENT products (consumed + development
     extra) x 10 stores, windows entirely inside 2015-06-01..2015-10-31, origins every 7 days from 2015-06-01.
     Computes U0 / U1 quantiles, U2 conformal corrections (selected CPU boosters) and D1 r_p per segment.
PK : frozen release on the 15 named categories (development extract). U0 / U1 from windows inside
     2017-07-01..2017-12-31 (every 7 days); E1 for Independence Day and Eid al-Adha only, alpha = 10, fitted on
     windows inside 2016-07-29..2017-12-31 (daily origins, F >= 1), pooled over named categories.

Reads only through data_access (guarded: no reserved product, no M5 day after 2015-10-31, no Pakistan row after
2017-12-31). Prints counts only, never targets.

Usage: python calibrate.py --market us|pk --out DIR
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

D, E = C.D, C.E
US_CAL = ("2015-06-01", "2015-10-31")
PK_UNC = ("2017-07-01", "2017-12-31")
PK_FIT = ("2016-07-29", "2017-12-31")
PK_E1_EVENTS = ["Independence Day", "Eid al-Adha"]
PK_ALPHA = 10.0
UNCAT = "\\N"


def selected_u2():
    d = C.STAGE3 / "outputs" / "u2_selected"
    index = json.loads((d / "index.json").read_text())
    out = {}
    for key, entry in index["models"].items():
        h, p = key.split("|")
        if D.sha256(d / entry["file"]) != entry["sha256"]:
            raise SystemExit(f"selected U2 booster {entry['file']} does not match its hash")
        b = xgb.Booster()
        b.load_model(str(d / entry["file"]))
        out[(int(h), float(p))] = b
    return out


def us_table(end):
    res = json.loads(D.RESERVATION.read_text())
    products = sorted(res["consumed_products"] + res["development_extra_products"])
    long = D.m5_daily(products, end)                    # guarded: raises for reserved products / later days
    launches = D.m5_launch_dates(products)
    long = long.merge(launches, on=["store_id", "item_id"], how="inner")
    long = long.loc[long.date >= long.launch_date]
    table = {}
    for (store, item), g in long.groupby(["store_id", "item_id"], sort=True):
        g = g.sort_values("date")
        if not g.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError(f"gap in {store} {item}")
        table[(store, item)] = {"start": g.date.iloc[0], "values": g.sales.to_numpy(dtype=float), "cat": g.cat_id.iloc[0]}
    return table


def pk_table():
    df = D.pakistan_dev()
    df["category"] = df.category.fillna(UNCAT).astype(str)
    days = pd.date_range("2016-07-01", "2017-12-31")
    daily = df.groupby(["category", "sale_date"]).quantity.sum().unstack(0).reindex(days).fillna(0.0)
    return {c: {"start": days[0], "values": daily[c].to_numpy(dtype=float), "cat": c} for c in daily.columns}


def pk_calendar_dev():
    return E.pk_calendar()


def calibrate_us(out_dir, log):
    t0 = time.time()
    boosters, manifest = C.production_boosters()
    table = us_table(US_CAL[1])
    log(f"US calibration series: {len(table)}")
    rows, X, parity = C.serve(table, C.origins_every(US_CAL[0], US_CAL[1], 7), boosters)
    log(f"US calibration windows: {len(rows)}; parity max |diff| vs ml/v2 forecast_totals = {parity:.3e} units")
    if parity >= 1e-3:
        raise SystemExit("parity with the application failed")
    u2 = selected_u2()
    calib = C.calibrate_totals(rows, X, u2)
    result = {"market": "us", "release": manifest.get("release"), "calibration_windows_within": list(US_CAL), "origins": "every 7 days",
              "series": len(table), "windows": int(len(rows)), "parity_max_abs_units": parity, **calib,
              "xgboost": xgb.__version__, "numpy": np.__version__, "pandas": pd.__version__, "seconds": round(time.time() - t0, 1)}
    (out_dir / "calibration_us.json").write_text(json.dumps(result, indent=2) + "\n")
    keep = rows[["series_key", "h", "origin", "group", "method", "F", "A"]].copy()
    keep.to_csv(out_dir / "calibration_us_rows.csv.gz", index=False, float_format="%.17g",
                                                                              compression={"method": "gzip", "mtime": 0})
    log("US calibration written (quantiles per segment x horizon x level; counts only shown here)")
    return result


def calibrate_pk(out_dir, log):
    t0 = time.time()
    boosters, manifest = C.production_boosters()
    table = pk_table()
    named = {k: v for k, v in table.items() if k != UNCAT}
    cal = pk_calendar_dev()
    rows, X, parity = C.serve(named, C.origins_every(PK_UNC[0], PK_UNC[1], 7), boosters)
    if parity >= 1e-2:   # frozen PK parity limit: category totals are hundreds to thousands of units
        raise SystemExit("parity with the application failed")
    log(f"PK U0/U1 windows: {len(rows)}; parity max |diff| = {parity:.3e} units")
    u = {"U0": {}, "U1": {}, "counts": {}}
    for scope, c in [("pooled", rows)] + [(g, rows.loc[rows.group == g]) for g in sorted(rows.group.unique())]:
        for h in C.HORIZONS:
            ch = c.loc[c.h == h]
            u["counts"][f"{scope}|{h}"] = int(len(ch))
            for p in C.LEVELS:
                if len(ch):
                    u["U0"][f"{scope}|{h}|{p}"] = float(C.U.finite_q((ch.A + 1) / (ch.F + 1), p))
                    u["U1"][f"{scope}|{h}|{p}"] = float(C.U.finite_q((ch.A - ch.F) / np.sqrt(ch.F + 1), p))
    # E1 for events with two fit occurrences
    fit, _, parity_fit = C.serve(named, C.origins_every(PK_FIT[0], PK_FIT[1], 1), boosters)
    fit = fit.loc[fit.F >= 1].reset_index(drop=True)
    names = E.feature_names(cal)
    keep = np.array([n.split("|")[0] in PK_E1_EVENTS for n in names])
    Xe = np.zeros((len(fit), len(names)))
    for h in C.HORIZONS:
        m = (fit.h == h).to_numpy()
        Xe[m] = E.exposure(fit.loc[m, "origin"], h, cal)[0]
    Xe = Xe[:, keep]
    agg = (fit.assign(**{f"x{j}": Xe[:, j] for j in range(Xe.shape[1])})
           .groupby(["origin", "h"]).agg(A=("A", "sum"), F=("F", "sum"), **{f"x{j}": (f"x{j}", "first") for j in range(Xe.shape[1])}))
    Xa = agg[[f"x{j}" for j in range(Xe.shape[1])]].to_numpy()
    exposed = Xa.sum(axis=0) > 0
    beta = np.zeros(Xa.shape[1])
    b, res = C.fit_poisson(Xa[:, exposed], agg.A.to_numpy(), agg.F.to_numpy(), PK_ALPHA)
    beta[exposed] = b
    occ = E.occurrences(cal, *PK_FIT, PK_E1_EVENTS)
    result = {"market": "pk", "release": manifest.get("release"), "scope": "15 named categories, recorded order quantities; marketplace only",
              "uncertainty_windows_within": list(PK_UNC), "windows": int(len(rows)), "parity_max_abs_units": parity, **u,
              "e1": {"events": PK_E1_EVENTS, "alpha": PK_ALPHA, "fit_windows_within": list(PK_FIT), "fit_occurrences": occ,
                     "converged": bool(res.success), "features": list(np.array(names)[keep]),
                     "beta": [float(x) for x in beta], "fit_rows": int(len(fit)), "fit_parity_max_abs_units": parity_fit},
              "xgboost": xgb.__version__, "numpy": np.__version__, "pandas": pd.__version__, "seconds": round(time.time() - t0, 1)}
    if any(len(v) < 2 for v in occ.values()) or set(occ) != set(PK_E1_EVENTS):
        raise SystemExit(f"E1 events need two fit occurrences each: {occ}")
    (out_dir / "calibration_pk.json").write_text(json.dumps(result, indent=2) + "\n")
    rows[["series_key", "h", "origin", "group", "method", "F", "A"]].to_csv(out_dir / "calibration_pk_rows.csv.gz", index=False, float_format="%.17g",
                                                                              compression={"method": "gzip", "mtime": 0})
    log("PK calibration written")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", choices=["us", "pk"], required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    log = lambda m: print(m, flush=True)  # noqa: E731
    (calibrate_us if a.market == "us" else calibrate_pk)(out, log)


if __name__ == "__main__":
    main()
