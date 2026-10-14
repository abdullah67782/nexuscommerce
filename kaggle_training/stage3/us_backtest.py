"""US (M5) development backtests with the research copies (dev protocol periods).

Outputs (outputs/cache/, git-ignored; summaries in outputs/us/):
  series.pkl          key -> (start date, daily values to 2015-05-31), category, department, product set
  fit_agg.pkl         FIT_A (R12) + FIT_B (R13), daily origins, aggregated by (period, origin, h, cat, store,
                      group): sums of A and F over series with F >= 1 unit, plus counts (event-layer fitting)
  fit_weekly.pkl      FIT rows at origins every 7 days, with v2 features (U2 training)
  cal.pkl, sel.pkl    CAL / SEL rows (R14, origins every 7 days) with features
  parity.json         max |difference| vs ml/v2 forecast_totals for 300 sampled rows per model
"""
import json
import pickle

import numpy as np
import pandas as pd
import xgboost as xgb

import data_access as D
from served import Series, parity_check, served

OUT = D.STAGE3 / "outputs"
CACHE = OUT / "cache"
MODELS = OUT / "research_models"
PERIODS = {"FIT_A": ("R12", "2012-06-01", "2013-05-31", 1), "FIT_B": ("R13", "2013-06-01", "2014-05-31", 1),
           "CAL": ("R14", "2014-06-01", "2014-10-31", 7), "SEL": ("R14", "2014-11-01", "2015-05-31", 7)}
DEV_END = "2015-05-31"


def boosters(name):
    out = {}
    for h in (7, 28):
        b = xgb.Booster()
        b.load_model(MODELS / f"{name}_{h}.json")
        out[h] = b
    return out


def load_series():
    path = CACHE / "series.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    res = json.loads(D.RESERVATION.read_text())
    products = sorted(res["consumed_products"] + res["development_extra_products"])
    sets = {p: "consumed" for p in res["consumed_products"]} | {p: "dev_extra" for p in res["development_extra_products"]}
    long = D.m5_daily(products, DEV_END)
    launches = D.m5_launch_dates(products)
    long = long.merge(launches, on=["store_id", "item_id"], how="inner")
    long = long.loc[long.date >= long.launch_date]
    table = {}
    for (store, item), g in long.groupby(["store_id", "item_id"], sort=True):
        g = g.sort_values("date")
        if not g.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            raise ValueError(f"gap in {store} {item}")
        table[(store, item)] = {"start": g.date.iloc[0], "values": g.sales.to_numpy(dtype=float),
                                "cat": g.cat_id.iloc[0], "dept": g.dept_id.iloc[0], "set": sets[item]}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(table))
    return table


def origin_fn(start, end, step):
    start, end = pd.Timestamp(start), pd.Timestamp(end)

    def fn(s, h):
        days = pd.date_range(start, end - pd.Timedelta(days=h - 1), freq=f"{step}D")
        return np.array([(d - s.start).days for d in days])
    return fn


def run_period(name, table, chunk=300):
    model, start, end, step = PERIODS[name]
    b = boosters(model)
    keys = sorted(table)
    agg_parts, weekly_parts, weekly_X = [], [], {7: [], 28: []}
    worst = 0.0
    for c in range(0, len(keys), chunk):
        ss = [Series(k, pd.date_range(table[k]["start"], periods=len(table[k]["values"])), table[k]["values"]) for k in keys[c:c + chunk]]
        rows, Xs = served(ss, origin_fn(start, end, step), b, with_features=True)
        if c == 0:
            worst = parity_check(ss, b, rows.loc[rows.method != "none"])
        rows["store_id"] = [k[0] for k in rows.key]
        rows["item_id"] = [k[1] for k in rows.key]
        rows["cat"] = [table[k]["cat"] for k in rows.key]
        rows["dept"] = [table[k]["dept"] for k in rows.key]
        rows["set"] = [table[k]["set"] for k in rows.key]
        if step == 1:
            ok = rows.F >= 1.0
            agg = rows.loc[ok].groupby(["origin", "h", "cat", "store_id", "group"], observed=True).agg(
                A=("A", "sum"), F=("F", "sum"), n=("A", "size")).reset_index()
            agg_parts.append(agg)
            wk = rows.loc[((rows.origin - pd.Timestamp(start)).dt.days % 7) == 0]
        else:
            wk = rows
        for h in (7, 28):
            sel = wk.loc[wk.h == h]
            weekly_X[h].append(Xs[h][sel["_xrow"].astype(int).to_numpy()])
        weekly_parts.append(wk.drop(columns=["key"]))
        print(name, f"{min(c + chunk, len(keys))}/{len(keys)} series", flush=True)
    weekly = pd.concat(weekly_parts, ignore_index=True)
    X = {h: np.concatenate(weekly_X[h]) for h in (7, 28)}
    # re-index feature rows per horizon in weekly order
    for h in (7, 28):
        weekly.loc[weekly.h == h, "_xrow"] = np.arange((weekly.h == h).sum())
    out = {"rows": weekly, "X": X}
    if agg_parts:
        out["agg"] = pd.concat(agg_parts, ignore_index=True)
    return out, worst


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    (OUT / "us").mkdir(parents=True, exist_ok=True)
    table = load_series()
    print("series", len(table), flush=True)
    parity = json.loads((OUT / "us" / "parity.json").read_text()) if (OUT / "us" / "parity.json").exists() else {}
    for name in PERIODS:
        path = CACHE / f"{name}.pkl"
        if path.exists():
            print("kept", name, flush=True)
            continue
        out, worst = run_period(name, table)
        parity[name] = {"model": PERIODS[name][0], "max_abs_difference_units": worst, "sampled_rows": 300}
        if worst > 1e-3:
            raise AssertionError(f"parity failed for {name}: {worst}")
        path.write_bytes(pickle.dumps(out))
        (OUT / "us" / "parity.json").write_text(json.dumps(parity, indent=2) + "\n")
        print(name, "rows", len(out["rows"]), "parity", worst, flush=True)


if __name__ == "__main__":
    main()
