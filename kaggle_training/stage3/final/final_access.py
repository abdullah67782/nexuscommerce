"""Reserved-data loaders for the ONE-TIME final evaluation. Nothing else may import this module.

A loader works only with a FinalGate, which final_runner.py creates after it has
  1. verified the frozen final protocol (hash given on the command line),
  2. verified every code / model / calibration / data hash listed there,
  3. created the run lock with O_CREAT | O_EXCL (a second run in the same lock folder is refused).

M5    : only the 90 reserved holdout products, sales days up to 2016-05-22, through the same
        column/row-restricted reading as data_access.m5_daily.
Pakistan: the full source file (sha256 fixed in the protocol); rows dated up to 2018-08-28.
"""
import csv
import zipfile
from datetime import date

import numpy as np
import pandas as pd

import data_access as D

FINAL_END_US = pd.Timestamp("2016-05-22")
FINAL_END_PK = date(2018, 8, 28)
UNCAT = "\\N"
NA_TEXT = {"", "NA", "N/A", "NULL", "NaN", "nan", "None", "null", "#N/A", "n/a", "<NA>"}   # pandas defaults, as in development


class FinalGate:
    _token = object()

    def __init__(self, token, protocol_sha256, lock_path):
        if token is not FinalGate._token:
            raise PermissionError("FinalGate is created only by final_runner after verification and locking")
        self.protocol_sha256 = protocol_sha256
        self.lock_path = lock_path


def _check(gate):
    if not isinstance(gate, FinalGate):
        raise PermissionError("reserved data needs a FinalGate")


def m5_final(gate, holdout_products):
    _check(gate)
    products = sorted(set(holdout_products))
    if set(products) != D.reserved_products():
        raise PermissionError("final M5 access is for exactly the reserved holdout products")
    calendar = D.m5_calendar()
    with zipfile.ZipFile(D.M5_DIR / "sales_train_evaluation.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        header = pd.read_csv(zf.open(name), nrows=0).columns.tolist()
        days = calendar.loc[calendar.d.isin(header) & (calendar.date <= FINAL_END_US)]
        day_cols = days.d.tolist()
        ids = pd.read_csv(zf.open(name), usecols=["item_id"])
        keep_lines = set((np.flatnonzero(ids.item_id.isin(products).to_numpy()) + 1).tolist())
        frame = pd.read_csv(zf.open(name), usecols=D.ID_COLUMNS[1:] + day_cols,
                            skiprows=lambda i: i != 0 and i not in keep_lines, dtype={d: "float32" for d in day_cols})
    if set(frame.item_id) != set(products):
        raise AssertionError("final frame does not contain exactly the holdout products")
    long = frame.melt(id_vars=D.ID_COLUMNS[1:], value_vars=day_cols, var_name="d", value_name="sales")
    long["date"] = long.d.map(days.set_index("d").date)
    return long.drop(columns=["d"])


def pakistan_final(gate, source_path, expected_sha256):
    _check(gate)
    if D.sha256(source_path) != expected_sha256:
        raise PermissionError("Pakistan source file differs from the protocol's hash")
    out = []
    with open(source_path, newline="", encoding="utf-8") as src:
        reader = csv.reader(src)
        header = next(reader)
        i_date = header.index("sale_date")
        idx = {c: header.index(c) for c in ["category", "quantity"]}
        for row in reader:
            m, d, y = row[i_date].split("/")
            day = date(int(y), int(m), int(d))
            if day > FINAL_END_PK:
                continue
            cat = row[idx["category"]]
            qty = row[idx["quantity"]]
            out.append((day, UNCAT if cat in NA_TEXT else cat, 0.0 if qty in NA_TEXT else float(qty)))
    df = pd.DataFrame(out, columns=["sale_date", "category", "quantity"])
    df["sale_date"] = pd.to_datetime(df.sale_date)
    return df
