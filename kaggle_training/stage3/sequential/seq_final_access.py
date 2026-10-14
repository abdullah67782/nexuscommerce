"""Reserved-data loader for the ONE-TIME sequential final run. Only seq_final.py may import it.

Works only with a SeqGate, which seq_final.py creates after it has verified the frozen sequential protocol and every
hash it lists, run the preflight, and created the run lock with O_CREAT | O_EXCL. Reads exactly the 150 reserved
products (all stores), sales days up to 2016-05-22, through the same column/row-restricted reading as development.
"""
import json
import zipfile

import numpy as np
import pandas as pd

import seq_data as SD

D = SD.D
FINAL_REPLAY = ("2015-11-23", "2016-05-22")


class SeqGate:
    _token = object()

    def __init__(self, token, protocol_sha256, lock_path):
        if token is not SeqGate._token:
            raise PermissionError("SeqGate is created only by seq_final after verification, preflight and locking")
        self.protocol_sha256 = protocol_sha256
        self.lock_path = lock_path


def final_table(gate):
    if not isinstance(gate, SeqGate):
        raise PermissionError("reserved data needs a SeqGate")
    products = sorted(SD.seq_reserved())
    if len(products) != 150:
        raise PermissionError("the sequential reservation must hold exactly 150 products")
    end = pd.Timestamp(FINAL_REPLAY[1])
    calendar = D.m5_calendar()
    with zipfile.ZipFile(D.M5_DIR / "sales_train_evaluation.csv.zip") as zf:
        name = [n for n in zf.namelist() if n.endswith(".csv")][0]
        header = pd.read_csv(zf.open(name), nrows=0).columns.tolist()
        days = calendar.loc[calendar.d.isin(header) & (calendar.date <= end)]
        day_cols = days.d.tolist()
        ids = pd.read_csv(zf.open(name), usecols=["item_id"])
        keep = set((np.flatnonzero(ids.item_id.isin(products).to_numpy()) + 1).tolist())
        frame = pd.read_csv(zf.open(name), usecols=D.ID_COLUMNS[1:] + day_cols,
                            skiprows=lambda i: i != 0 and i not in keep, dtype={d: "float32" for d in day_cols})
    if set(frame.item_id) != set(products):
        raise AssertionError("the final frame does not contain exactly the reserved products")
    long = frame.melt(id_vars=D.ID_COLUMNS[1:], value_vars=day_cols, var_name="d", value_name="sales")
    long["date"] = long.d.map(days.set_index("d").date)
    long = long.drop(columns=["d"])
    launches = D.m5_launch_dates(products)
    prices = SD.daily_prices(products, FINAL_REPLAY[1], final_gate=gate)
    return SD.build_table(long, launches, prices, *FINAL_REPLAY)
