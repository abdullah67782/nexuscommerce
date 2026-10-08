"""v2 total-demand forecasts for the next 7 and 28 days.

Input: one product's usable history — complete consecutive daily totals with
no unknown days (the backend resolves coverage and gaps before calling).
Output: one total per horizon with its dates and method. No daily breakdown,
accuracy figure or confidence interval is produced.

History tiers (architect decision, 2026-10):
  fewer than 28 days  -> insufficient history, no forecast
  28 to 179 days      -> average-based estimate: mean of the last 28 days x horizon
  180 days or more    -> frozen rule: rare sellers -> TSB, otherwise the shared model
"""
from datetime import date, timedelta

import numpy as np

from .features import FEATURES, origin_features, scale
from .methods import GROUP_WINDOW_DAYS, ROUTE, mean_28_total, planning_group, selling_fraction, tsb_total

HORIZONS = (7, 28)
MIN_AVERAGE_DAYS = 28
MIN_MODEL_DAYS = 180

METHODS = {
    "shared_model": "Shared forecasting model (v2)",
    "tsb": "Rare-sales method (TSB)",
    "average_28": "Average-based estimate",
}


def history_tier(days):
    if days < MIN_AVERAGE_DAYS:
        return "insufficient"
    if days < MIN_MODEL_DAYS:
        return "average"
    return "model"


def _validate(start, quantities):
    if not isinstance(start, date):
        raise TypeError("start must be a datetime.date")
    values = np.asarray(quantities, dtype=float)
    if values.ndim != 1:
        raise ValueError("quantities must be a flat list of daily totals")
    if not np.all(np.isfinite(values)) or np.any(values < 0):
        raise ValueError("daily totals must be finite and non-negative")
    return values


def shared_model_total(booster, history, origin, horizon):
    import xgboost as xgb

    row = origin_features(history, origin).astype(np.float32).reshape(1, -1)
    prediction = booster.predict(xgb.DMatrix(row, feature_names=FEATURES))[0]
    return max(0.0, float(prediction * (scale(history) * horizon)))


def forecast_totals(start, quantities, models=None):
    """Forecast totals for the days after the supplied history.

    start      -- date of quantities[0]
    quantities -- daily totals, oldest first, consecutive, all known
    models     -- {7: Booster, 28: Booster}; needed only for the model tier
    """
    values = _validate(start, quantities)
    days = len(values)
    tier = history_tier(days)
    last = start + timedelta(days=days - 1) if days else None
    origin = last + timedelta(days=1) if days else None
    result = {
        "history": {
            "usable_days": days,
            "first_day": start.isoformat() if days else None,
            "last_day": last.isoformat() if days else None,
            "tier": tier,
            "required_days": {"average": MIN_AVERAGE_DAYS, "model": MIN_MODEL_DAYS},
        },
        "pattern": None,
        "forecasts": [],
    }
    if tier == "insufficient":
        result["status"] = "insufficient_history"
        return result

    if tier == "model":
        fraction = selling_fraction(values, GROUP_WINDOW_DAYS)
        group = planning_group(fraction)
        method = ROUTE[group]
        result["pattern"] = {"group": group, "selling_day_percent": round(100 * fraction, 1),
                             "window_days": GROUP_WINDOW_DAYS}
        if method == "shared_model" and not models:
            raise RuntimeError("v2 production models are not loaded")
    else:
        method = "average_28"

    for horizon in HORIZONS:
        if method == "shared_model":
            total = shared_model_total(models[horizon], values, origin, horizon)
        elif method == "tsb":
            total = tsb_total(values, horizon)
        else:
            total = mean_28_total(values, horizon)
        result["forecasts"].append({
            "horizon_days": horizon,
            "start": origin.isoformat(),
            "end": (origin + timedelta(days=horizon - 1)).isoformat(),
            "total_units": float(total),
            "method": method,
            "method_label": METHODS[method],
        })
    result["status"] = "ok"
    return result
