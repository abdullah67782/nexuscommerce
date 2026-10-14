"""Guarded data access for Stage 3 (architect review 2026-10-13, item 1).

Every Stage 3 script reads data ONLY through this module. The guards are structural:

M5
  * Columns: only the sales-day columns up to the requested end date are selected
    (`usecols`); later days are never converted into values.
  * Rows: only the requested products' rows are kept; every other row is skipped by
    the CSV parser (`skiprows`), so no other product's sales are converted or held.
  * Development calls may not end after DEV_END_US and may not request a reserved
    holdout product. Final evaluation access is sealed (FinalAccessSealed).
  * Prices (launch dates) are inputs, not targets; price rows are filtered per chunk.

Pakistan e-commerce
  * The cloud workspace only ever receives the development extract made on the
    owner's machine by extract_pakistan_dev.py, which tests the date field of each
    line first and drops later lines without converting any other field.
  * This loader verifies the extract's manifest and that no date exceeds DEV_END_PK.

Store Item Demand is not used by Stage 3 experiments.
"""
from pathlib import Path
import hashlib
import json
import zipfile

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
M5_DIR = ROOT / "data" / "m5"
STAGE3 = ROOT / "kaggle_training" / "stage3"
RESERVATION = STAGE3 / "outputs" / "reservation_m5.json"
PK_EXTRACT = STAGE3 / "data_dev" / "pakistan_dev_2016-07-01_2017-12-31.csv"
PK_MANIFEST = STAGE3 / "data_dev" / "pakistan_dev_manifest.json"

DEV_END_US = pd.Timestamp("2015-10-31")   # no development calculation uses later M5 days
DEV_END_PK = pd.Timestamp("2017-12-31")   # 2018-01-01 .. 2018-08-28 is the Pakistan final period
ID_COLUMNS = ["id", "item_id", "dept_id", "cat_id", "store_id", "state_id"]


class FinalAccessSealed(PermissionError):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def m5_calendar():
    return pd.read_csv(M5_DIR / "calendar.csv", parse_dates=["date"])


def m5_catalog():
    """Catalog columns only (no sales values)."""
    with zipfile.ZipFile(M5_DIR / "sales_train_evaluation.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        return pd.read_csv(zf.open(name), usecols=ID_COLUMNS)


def reserved_products():
    if not RESERVATION.exists():
        return set()
    return set(json.loads(RESERVATION.read_text())["holdout_products"])


def m5_daily(products, end, *, start=None):
    """Long daily sales (store_id, item_id, cat_id, dept_id, date, sales) for `products`, dates <= end.

    Development access only. Raises if a reserved product is requested or end > DEV_END_US.
    """
    end = pd.Timestamp(end)
    products = sorted(set(products))
    if end > DEV_END_US:
        raise FinalAccessSealed(f"development access ends {DEV_END_US.date()}; requested {end.date()}")
    clash = set(products) & reserved_products()
    if clash:
        raise FinalAccessSealed(f"{len(clash)} reserved holdout products requested in development")
    calendar = m5_calendar()
    with zipfile.ZipFile(M5_DIR / "sales_train_evaluation.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        header = pd.read_csv(zf.open(name), nrows=0).columns.tolist()
        days = calendar.loc[calendar.d.isin(header) & (calendar.date <= end)]
        if start is not None:
            days = days.loc[days.date >= pd.Timestamp(start)]
        day_cols = days.d.tolist()
        ids = pd.read_csv(zf.open(name), usecols=["item_id"])
        keep_lines = set((np.flatnonzero(ids.item_id.isin(products).to_numpy()) + 1).tolist())  # +1: header line
        frame = pd.read_csv(zf.open(name), usecols=ID_COLUMNS[1:] + day_cols,
                            skiprows=lambda i: i != 0 and i not in keep_lines,
                            dtype={d: "float32" for d in day_cols})
    if set(frame.item_id) - set(products):
        raise AssertionError("a non-requested product reached the frame")
    long = frame.melt(id_vars=ID_COLUMNS[1:], value_vars=day_cols, var_name="d", value_name="sales")
    long["date"] = long.d.map(days.set_index("d").date)
    long = long.drop(columns=["d"])
    if long.date.max() > end:
        raise AssertionError("a date after the access limit reached the frame")
    return long


def m5_launch_dates(products):
    """First recorded price week per (store, item): a launch proxy. Prices are inputs, not targets."""
    calendar = m5_calendar()
    week_starts = calendar.groupby("wm_yr_wk").date.min()
    products = set(products)
    earliest = None
    with zipfile.ZipFile(M5_DIR / "sell_prices.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        for chunk in pd.read_csv(zf.open(name), usecols=["store_id", "item_id", "wm_yr_wk"], chunksize=500000):
            chunk = chunk.loc[chunk.item_id.isin(products)]
            first = chunk.groupby(["store_id", "item_id"]).wm_yr_wk.min()
            earliest = first if earliest is None else pd.concat([earliest, first]).groupby(level=[0, 1]).min()
    out = earliest.rename("first_week").reset_index()
    out["launch_date"] = out.first_week.map(week_starts)
    return out[["store_id", "item_id", "launch_date"]]


def pakistan_dev():
    """Development extract (rows dated <= DEV_END_PK). Verifies the extract's manifest."""
    manifest = json.loads(PK_MANIFEST.read_text())
    if manifest["extract_sha256"] != sha256(PK_EXTRACT):
        raise AssertionError("Pakistan development extract changed after it was made")
    if manifest["dev_end"] != str(DEV_END_PK.date()):
        raise AssertionError("extract made with a different development boundary")
    df = pd.read_csv(PK_EXTRACT, parse_dates=["sale_date"])
    if df.sale_date.max() > DEV_END_PK:
        raise FinalAccessSealed("a Pakistan final-period row reached development data")
    return df
