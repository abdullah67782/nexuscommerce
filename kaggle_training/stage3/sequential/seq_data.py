"""Data for the sequential inventory evaluation (development side; the final side is in seq_final_access.py).

Development uses only products already read in earlier stages (consumed 180 + development_extra 150) through the
guarded loader data_access.m5_daily (no reserved product, no M5 day after 2015-10-31). Prices are inputs (sell
prices per store, item and week), read row-filtered for the requested products and weeks only.
"""
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

STAGE3 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STAGE3))
import data_access as D  # noqa: E402

DEV_REPLAY = ("2015-05-03", "2015-10-31")       # 182 days, inside development data
SEQ_RESERVATION = STAGE3 / "outputs" / "reservation_seq_m5.json"


def seq_reserved():
    return set(json.loads(SEQ_RESERVATION.read_text())["products"]) if SEQ_RESERVATION.exists() else set()


def guard(products):
    clash = set(products) & seq_reserved()
    if clash:
        raise D.FinalAccessSealed(f"{len(clash)} products reserved for the sequential final run were requested in development")
REPLAY_DAYS = 182


def daily_prices(products, end, *, final_gate=None):
    """{(store, item): Series(date -> price)} for weeks starting on or before `end`; forward/back filled per series."""
    if final_gate is None:
        guard(products)
        if pd.Timestamp(end) > D.DEV_END_US:
            raise D.FinalAccessSealed("development prices end on 2015-10-31")
    cal = D.m5_calendar()
    cal = cal.loc[cal.date <= pd.Timestamp(end)]
    weeks = set(cal.wm_yr_wk)
    products = set(products)
    parts = []
    with zipfile.ZipFile(D.M5_DIR / "sell_prices.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        for chunk in pd.read_csv(zf.open(name), chunksize=500000):
            chunk = chunk.loc[chunk.item_id.isin(products) & chunk.wm_yr_wk.isin(weeks)]
            if len(chunk):
                parts.append(chunk)
    prices = pd.concat(parts) if parts else pd.DataFrame(columns=["store_id", "item_id", "wm_yr_wk", "sell_price"])
    daily = cal[["date", "wm_yr_wk"]].merge(prices, on="wm_yr_wk", how="inner")
    out = {}
    for (store, item), g in daily.groupby(["store_id", "item_id"]):
        out[(store, item)] = g.set_index("date").sell_price.sort_index()
    return out


def build_table(long, launches, prices, start, end):
    """Series with full daily history from launch to `end`, the replay window values, and daily prices in it.
    Returns (table, excluded) where table[key] = {start, values (to end), cat, item, store, i0, actual, price}."""
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    long = long.merge(launches, on=["store_id", "item_id"], how="inner")
    long = long.loc[(long.date >= long.launch_date) & (long.date <= end)]
    days = pd.date_range(start, end)
    table, excluded = {}, {"history_under_28_days": 0, "no_price": 0, "gap": 0}
    for (store, item), g in long.groupby(["store_id", "item_id"], sort=True):
        g = g.sort_values("date")
        if not g.date.diff().dropna().eq(pd.Timedelta(days=1)).all():
            excluded["gap"] += 1
            continue
        first = g.date.iloc[0]
        i0 = int((start - first).days)
        if i0 < 28:
            excluded["history_under_28_days"] += 1
            continue
        p = prices.get((store, item))
        if p is None or p.dropna().empty:
            excluded["no_price"] += 1
            continue
        price = p.reindex(days).ffill().bfill()
        if price.isna().any():
            price = price.fillna(float(p.dropna().iloc[0]))
        values = g.sales.to_numpy(dtype=float)
        table[(store, item)] = {"start": first, "values": values, "cat": g.cat_id.iloc[0], "item": item, "store": store,
                                "i0": i0, "actual": values[i0:i0 + len(days)], "price": price.to_numpy(dtype=float)}
    return table, excluded


def dev_table(products=None):
    res = json.loads(D.RESERVATION.read_text())
    products = sorted(products or (res["consumed_products"] + res["development_extra_products"]))
    guard(products)
    long = D.m5_daily(products, DEV_REPLAY[1])
    launches = D.m5_launch_dates(products)
    prices = daily_prices(products, DEV_REPLAY[1])
    return build_table(long, launches, prices, *DEV_REPLAY)
