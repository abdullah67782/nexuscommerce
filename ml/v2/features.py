"""Frozen forecast inputs for v2, computed with numpy only.

This is a line-by-line port of the experiment code that produced the approved
results (kaggle_training/new_training: store_personalization.features_for_series
and weekly_forecasting.weekly_features), evaluated at ONE forecast origin:

    history  = complete consecutive daily totals for the days BEFORE the origin
    origin   = the first day being forecast (history's last day + 1)

Nothing from the origin day or later enters any input. ml/tests/test_v2_parity.py
checks this port against the experiment code, and against the predictions saved
by the frozen evaluation.

Uses only numpy APIs available in numpy 1.26 (the application's pinned version).
"""
from datetime import date

import numpy as np

# Order is part of the model contract; registry.py checks it against each model.
FEATURES = [
    "day_of_week", "month", "is_weekend", "dow_sin", "dow_cos", "doy_sin", "doy_cos",
    "lag_1_relative", "lag_2_relative", "lag_7_relative", "lag_14_relative", "lag_28_relative",
    "mean_7_relative", "std_7_relative", "mean_14_relative", "std_14_relative",
    "mean_28_relative", "std_28_relative", "trend_7_relative",
    "selling_fraction_28", "selling_fraction_56", "positive_quantity_relative", "days_since_sale",
]

MIN_FEATURE_DAYS = 56  # every input defined (selling_fraction_56 is the longest window)


def scale(history):
    """Previous 28-day mean + 1 (the experiment's `scale`)."""
    values = np.asarray(history, dtype=float)
    if len(values) < 28:
        raise ValueError("scale needs at least 28 days")
    return float(values[-28:].mean()) + 1.0


def origin_features(history, origin):
    """Inputs for a forecast starting on `origin` (a datetime.date).

    `history` is the list/array of daily totals for the days immediately before
    `origin`, oldest first, with no gaps. Returns a float64 vector in FEATURES order.
    """
    values = np.asarray(history, dtype=float)
    n = len(values)
    if n < MIN_FEATURE_DAYS:
        raise ValueError(f"model inputs need at least {MIN_FEATURE_DAYS} consecutive days, got {n}")
    if not np.all(np.isfinite(values)) or np.any(values < 0):
        raise ValueError("daily totals must be finite and non-negative")
    if not isinstance(origin, date):
        raise TypeError("origin must be a datetime.date")

    s = scale(values)
    dow = origin.weekday()                     # pandas dayofweek: Monday = 0
    doy = origin.timetuple().tm_yday           # pandas dayofyear
    row = {
        "day_of_week": dow,
        "month": origin.month,
        "is_weekend": int(dow >= 5),
        "dow_sin": np.sin(2 * np.pi * dow / 7),
        "dow_cos": np.cos(2 * np.pi * dow / 7),
        "doy_sin": np.sin(2 * np.pi * doy / 365.25),
        "doy_cos": np.cos(2 * np.pi * doy / 365.25),
    }
    for lag in (1, 2, 7, 14, 28):
        row[f"lag_{lag}_relative"] = values[n - lag] / s
    for window in (7, 14, 28):
        recent = values[n - window:]
        row[f"mean_{window}_relative"] = recent.mean() / s
        row[f"std_{window}_relative"] = recent.std(ddof=0) / s
    row["trend_7_relative"] = (values[n - 1] - values[n - 8]) / s
    for window in (28, 56):
        row[f"selling_fraction_{window}"] = float(np.mean(values[n - window:] > 0))
    recent = values[n - 28:]
    positive = recent[recent > 0]
    row["positive_quantity_relative"] = (positive.mean() if len(positive) else 0.0) / s
    sold = np.flatnonzero(values > 0)
    # Days since the last positive day (1 = sold yesterday); n + 1 when never sold
    # in the supplied history, as in the experiment.
    row["days_since_sale"] = float(n - sold[-1]) if len(sold) else float(n + 1)
    return np.array([row[name] for name in FEATURES], dtype=float)
