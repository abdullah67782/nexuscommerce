"""Event calendars and exposure features (dev protocol: buckets, primary events, lunar spread).

exposure(origins, h, calendar) -> matrix [n_origins x (events x buckets)] where each value is
(days of the window [origin, origin+h-1] falling in the bucket) / h. Information available at
the origin: US (M5) events are fixed in advance; Pakistan lunar events use the expected date
spread evenly over day-1..day+1 unless the origin is on or after day-1.
"""
import numpy as np
import pandas as pd

import data_access as D

BUCKETS = {"pre2": (-14, -8), "pre1": (-7, -1), "d0": (0, 0), "post1": (1, 3), "post2": (4, 7)}
PRIMARY_US = ["Christmas", "NewYear", "Thanksgiving", "Easter", "IndependenceDay", "MemorialDay", "LaborDay",
              "Eid al-Fitr", "EidAlAdha", "Ramadan starts"]

# Pakistan (approximate; lunar = moon-sighting dependent). Development period only.
PK_EVENTS = [
    ("Eid al-Fitr", "2016-07-06", True), ("Independence Day", "2016-08-14", False), ("Eid al-Adha", "2016-09-13", True),
    ("Black/White Friday", "2016-11-25", False), ("Christmas / Quaid Day", "2016-12-25", False), ("New Year", "2017-01-01", False),
    ("Pakistan Day", "2017-03-23", False), ("Labour Day", "2017-05-01", False), ("Ramadan start", "2017-05-27", True),
    ("Eid al-Fitr", "2017-06-26", True), ("Independence Day", "2017-08-14", False), ("Eid al-Adha", "2017-09-02", True),
    ("Black/White Friday", "2017-11-24", False), ("Christmas / Quaid Day", "2017-12-25", False),
]
PRIMARY_PK = ["Eid al-Fitr", "Eid al-Adha", "Ramadan start", "Independence Day", "Christmas / Quaid Day", "New Year",
              "Pakistan Day", "Black/White Friday"]


def us_calendar():
    cal = D.m5_calendar()
    rows = []
    for n, t in [("event_name_1", "event_type_1"), ("event_name_2", "event_type_2")]:
        e = cal.loc[cal[n].notna(), ["date", n, t]]
        rows += [(r[n], r["date"], False) for _, r in e.iterrows()]
    return pd.DataFrame(rows, columns=["event", "date", "lunar"]).sort_values("date").reset_index(drop=True)


def pk_calendar():
    return pd.DataFrame([(e, pd.Timestamp(d), lunar) for e, d, lunar in PK_EVENTS], columns=["event", "date", "lunar"])


def feature_names(calendar):
    return [f"{e}|{b}" for e in sorted(calendar.event.unique()) for b in BUCKETS]


def exposure(origins, h, calendar):
    """origins: DatetimeIndex. Returns (matrix float32, names)."""
    names = feature_names(calendar)
    col = {n: j for j, n in enumerate(names)}
    origins = pd.DatetimeIndex(origins)
    X = np.zeros((len(origins), len(names)), dtype=np.float32)
    o = origins.values.astype("datetime64[D]").astype(np.int64)
    for _, ev in calendar.iterrows():
        d = np.int64(np.datetime64(ev.date, "D").astype(np.int64))
        for b, (lo, hi) in BUCKETS.items():
            j = col[f"{ev.event}|{b}"]
            if ev.lunar:
                # expected date +/-1 spread unless the origin is on/after the day before the event
                known = o >= d - 1
                for shift in (-1, 0, 1):
                    days = _overlap(o, h, d + shift + lo, d + shift + hi)
                    X[:, j] += np.where(known, days if shift == 0 else 0, days / 3.0) / h
            else:
                X[:, j] += _overlap(o, h, d + lo, d + hi) / h
    return X, names


def _overlap(o, h, a, b):
    """days of [o, o+h-1] inside [a, b] (vectorised over o)."""
    return np.clip(np.minimum(o + h - 1, b) - np.maximum(o, a) + 1, 0, None).astype(np.float32)


def event_window_flag(origins, h, calendar, primary):
    """window overlaps [d-7, d+3] of any primary event."""
    o = pd.DatetimeIndex(origins).values.astype("datetime64[D]").astype(np.int64)
    flag = np.zeros(len(o), dtype=bool)
    for _, ev in calendar.loc[calendar.event.isin(primary)].iterrows():
        d = np.int64(np.datetime64(ev.date, "D").astype(np.int64))
        flag |= _overlap(o, h, d - 7, d + 3) > 0
    return flag


def occurrences(calendar, start, end, primary=None):
    c = calendar.loc[(calendar.date >= pd.Timestamp(start)) & (calendar.date <= pd.Timestamp(end))]
    if primary is not None:
        c = c.loc[c.event.isin(primary)]
    return c.groupby("event").date.apply(lambda s: [str(x.date()) for x in s]).to_dict()
