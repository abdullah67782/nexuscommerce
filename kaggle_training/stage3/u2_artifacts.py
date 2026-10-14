"""U2 quantile boosters: the exact development recipe (us_uncertainty.py), saved as artifacts.

Recipe (unchanged from development; GPU availability does not change it):
  XGBRegressor(n_estimators=250, max_depth=5, learning_rate=0.05, min_child_weight=20, subsample=0.85,
               objective="reg:quantileerror", quantile_alpha=p, tree_method="hist", n_jobs=2, random_state=42)
  features = [v2 origin features (FEATURES order), log1p(F), history_days, sell_frac_180]
  target   = (A + 1) / (F + 1)
  training rows = FIT_A (R12) + FIT_B (R13) rows at origins every 7 days, method not null.
Upper bound (units) = max(0, (booster(x) + c_seg) * (F + 1) - 1), where c_seg is the finite-sample
p-quantile of CAL scores (A+1)/(F+1) - booster(x) for the segment (split-conformal correction).

`device="cpu"` reproduces the development artifacts. `device="cuda"` exists only for diagnostics:
GPU histogram building can produce different trees, so GPU boosters are never substituted for the
selected CPU artifacts.
"""
import math

import numpy as np
import xgboost as xgb

LEVELS = (0.8, 0.9)
HORIZONS = (7, 28)
SEGMENTS = ["regular", "occasional", "rare", "dormant", "short_history"]
RECIPE = dict(n_estimators=250, max_depth=5, learning_rate=0.05, min_child_weight=20, subsample=0.85,
              objective="reg:quantileerror", tree_method="hist", n_jobs=2, random_state=42)


def finite_q(x, p):
    """Finite-sample quantile: the ceil((n+1)p)-th smallest value (capped at n). Same as us_uncertainty.finite_q."""
    x = np.sort(np.asarray(x, dtype=float))
    n = len(x)
    if n == 0:
        return np.nan
    k = min(n, math.ceil((n + 1) * p))
    return x[k - 1]


def features(rows, X, h):
    """rows: served rows (method not null) with _xrow, F, history_days, sell_frac_180; X: {h: matrix}."""
    r = rows.loc[rows.h == h]
    return np.column_stack([X[h][r["_xrow"].astype(int).to_numpy()], np.log1p(r.F.to_numpy()),
                            r.history_days.to_numpy(), r.sell_frac_180.to_numpy()])


def target(rows, h):
    r = rows.loc[rows.h == h]
    return ((r.A + 1) / (r.F + 1)).to_numpy()


def train(fit_parts, h, p, device="cpu"):
    """fit_parts: list of (rows, X). Returns an xgboost Booster."""
    Xtr = np.vstack([features(rows, X, h) for rows, X in fit_parts])
    ytr = np.concatenate([target(rows, h) for rows, _ in fit_parts])
    params = dict(RECIPE, quantile_alpha=p)
    if device != "cpu":
        params["device"] = device
    model = xgb.XGBRegressor(**params)
    model.fit(Xtr, ytr)
    return model.get_booster()


def predict(booster, Xf):
    return booster.inplace_predict(np.asarray(Xf))


def corrections(booster, cal_rows, cal_X, h, p):
    """Per-segment split-conformal correction from calibration rows."""
    c = cal_rows.loc[cal_rows.h == h]
    q = predict(booster, features(cal_rows, cal_X, h))
    score = (c.A.to_numpy() + 1) / (c.F.to_numpy() + 1) - q
    out = {}
    for seg in SEGMENTS:
        m = (c.group == seg).to_numpy()
        if m.any():
            out[seg] = float(finite_q(score[m], p))
    return out


def uppers(booster, corr, rows, X, h):
    """Upper bounds for rows with this horizon (order of rows.loc[rows.h == h])."""
    r = rows.loc[rows.h == h]
    q = predict(booster, features(rows, X, h))
    c = r.group.map(corr).astype(float).fillna(0.0).to_numpy()
    return np.maximum((q + c) * (r.F.to_numpy() + 1) - 1, 0)
