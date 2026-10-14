"""Vectorised 'as served' v2 forecasts for many series and origins (research use).

Reproduces ml/v2/forecast.forecast_totals exactly, for a given pair of boosters:
  history < 28 days -> none; 28-179 days -> 28-day average x h;
  >= 180 days -> pattern group from the last 180 days; rare -> TSB, else shared model.
Features are computed with the application's own ml/v2 origin_features at every origin.
(The pandas training-feature code differs by ~4e-7, which can cross a tree split and move a
forecast by up to 0.65 units; found by parity_check, so the app's numpy code is used.) TSB states are computed in one pass per series.
"""
import sys

import numpy as np
import pandas as pd
import xgboost as xgb

import data_access as D

sys.path[:0] = [str(D.ROOT / "kaggle_training" / "new_training"), str(D.ROOT / "ml")]
from v2.features import FEATURES, MIN_FEATURE_DAYS, origin_features  # noqa: E402
from v2.methods import planning_group  # noqa: E402

ALPHA = BETA = 0.1


def tsb_prefix_rates(v):
    """rate[i] = TSB daily rate from v[:i] (identical arithmetic to v2.methods.intermittent_rates)."""
    n = len(v)
    out = np.zeros(n + 1)
    pos = np.flatnonzero(v > 0)
    if not len(pos):
        return out
    first = pos[0]
    size = float(v[first])
    interval = float(first + 1)
    probability = 1 / interval
    out[first + 1] = probability * size
    for j in range(first + 1, n):
        q = v[j]
        probability += BETA * (float(q > 0) - probability)
        if q > 0:
            size += ALPHA * (q - size)
        out[j + 1] = max(0., probability * size)
    return out


class Series:
    def __init__(self, key, dates, values):
        self.key = key
        self.dates = pd.DatetimeIndex(dates)
        self.v = np.asarray(values, dtype=float)
        self.start = self.dates[0]
        self.cum = np.concatenate([[0.], np.cumsum(self.v)])
        self.pos_cum = np.concatenate([[0], np.cumsum(self.v > 0)])
        self._tsb = None
        self._feat = None

    def index_of(self, day):
        return int((pd.Timestamp(day) - self.start).days)

    def tsb(self):
        if self._tsb is None:
            self._tsb = tsb_prefix_rates(self.v)
        return self._tsb

    def features_at(self, idx):
        """Exactly the application's inputs: ml/v2 origin_features on v[:i] (numpy), for each origin index."""
        if self._feat is None:
            self._feat = {}
        X = np.full((len(idx), len(FEATURES)), np.nan, dtype=np.float32)
        scale = np.full(len(idx), np.nan)
        for r, i in enumerate(idx):
            if i >= MIN_FEATURE_DAYS:
                if i not in self._feat:   # shared by both horizons
                    self._feat[i] = (origin_features(self.v[:i], (self.start + pd.Timedelta(days=int(i))).date()).astype(np.float32),
                                     self.v[i - 28:i].mean() + 1.0)
                X[r], scale[r] = self._feat[i]
        return X, scale

    def actual(self, i, h):
        return self.cum[i + h] - self.cum[i]


def served(series_list, origins_for, boosters, horizons=(7, 28), with_features=False):
    """origins_for(series, h) -> array of origin indices i (history = v[:i], window = v[i:i+h]).
    Returns one row per (series, h, origin)."""
    rows, feats = [], {h: [] for h in horizons}
    for s in series_list:
        for h in horizons:
            idx = np.asarray(origins_for(s, h), dtype=int)
            idx = idx[(idx >= 28) & (idx + h <= len(s.v))]
            if not len(idx):
                continue
            hist = idx
            mean28 = (s.cum[hist] - s.cum[hist - 28]) / 28
            w = np.minimum(hist, 180)
            frac = (s.pos_cum[hist] - s.pos_cum[hist - w]) / w
            tier = np.where(hist < 180, "average", "model")
            group = np.array([planning_group(f) for f in frac], dtype=object)
            group[tier == "average"] = "short_history"
            method = np.where(tier == "average", "average_28", np.where(group == "rare", "tsb", "shared_model"))
            F = np.where(method == "average_28", mean28 * h, np.where(method == "tsb", s.tsb()[hist] * h, np.nan))
            A = s.cum[hist + h] - s.cum[hist]
            frame = pd.DataFrame({"key": [s.key] * len(idx), "h": h, "i": idx, "origin": s.start + pd.to_timedelta(idx, unit="D"),
                                  "history_days": hist, "tier": tier, "group": group, "method": method, "F": F, "A": A,
                                  "mean28": mean28, "sell_frac_180": frac})
            X, scale = s.features_at(idx)    # always, so feature rows stay aligned with output rows
            frame["scale"] = scale
            feats[h].append(X)
            rows.append(frame)
    out = pd.concat(rows, ignore_index=True)
    out["F"] = out["F"].astype(float)
    Xs = {}
    for h in horizons:
        part = out.index[(out.h == h)]
        X = np.concatenate(feats[h]) if feats[h] else None
        if X is None:
            continue
        m = out.loc[part, "method"].to_numpy() == "shared_model"
        if m.any():
            pred = boosters[h].predict(xgb.DMatrix(X[m], feature_names=FEATURES))
            sc = out.loc[part, "scale"].to_numpy()[m]
            out.loc[part[m], "F"] = np.maximum(0.0, pred * sc * h)
        out.loc[part, "_xrow"] = np.arange(len(part))
        Xs[h] = X
    return (out, Xs) if with_features else out


def parity_check(series_list, boosters, rows, n=300, seed=11):
    """Recompute n sampled forecasts with the application's own forecast_totals."""
    from datetime import date
    from v2.forecast import forecast_totals
    rng = np.random.default_rng(seed)
    by_key = {s.key: s for s in series_list}
    sample = rows.iloc[rng.choice(len(rows), size=min(n, len(rows)), replace=False)]
    worst = 0.0
    for _, r in sample.iterrows():
        s = by_key[r.key]
        res = forecast_totals(s.start.date(), s.v[:r.i], boosters)
        got = next(f["total_units"] for f in res["forecasts"] if f["horizon_days"] == r.h)
        worst = max(worst, abs(got - r.F))
    return worst
