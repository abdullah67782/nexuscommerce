"""Frozen non-model parts of v2: sales-pattern groups, TSB and the selection rule.

Copied from the experiment without changes to the arithmetic:
  - planning_group      <- analyze_sales_patterns.planning_group
  - intermittent_rates  <- weekly_forecasting.intermittent_rates (alpha = beta = 0.1)
  - ROUTE               <- frozen protocol routes (nexus-final-protocol-20261006-v1)
"""
import numpy as np

GROUP_WINDOW_DAYS = 180
ALPHA = 0.1
BETA = 0.1

# Rare sellers -> TSB; regular, occasional and dormant -> the shared model.
# Identical for both horizons in the frozen protocol.
ROUTE = {"regular": "shared_model", "occasional": "shared_model", "rare": "tsb", "dormant": "shared_model"}


def planning_group(positive_fraction):
    if positive_fraction == 0:
        return "dormant"
    if positive_fraction < 0.20:
        return "rare"
    if positive_fraction < 0.80:
        return "occasional"
    return "regular"


def selling_fraction(history, window=GROUP_WINDOW_DAYS):
    values = np.asarray(history, dtype=float)[-window:]
    return float(np.mean(values > 0))


def intermittent_rates(values, alpha=ALPHA, beta=BETA):
    """Daily SBA-Croston and TSB rates from earlier observations only."""
    values = np.asarray(values, dtype=float)
    locations = np.flatnonzero(values > 0)
    if not len(locations):
        return 0., 0.
    first = locations[0]
    size = float(values[first])
    interval = float(first + 1)
    probability = 1 / interval
    croston_size = size
    gap = 1
    for quantity in values[first + 1:]:
        probability += beta * (float(quantity > 0) - probability)
        if quantity > 0:
            croston_size += alpha * (quantity - croston_size)
            interval += alpha * (gap - interval)
            size += alpha * (quantity - size)
            gap = 1
        else:
            gap += 1
    return max(0., (1 - alpha / 2) * croston_size / interval), max(0., probability * size)


def tsb_total(history, horizon):
    return intermittent_rates(history)[1] * horizon


def mean_28_total(history, horizon):
    values = np.asarray(history, dtype=float)
    return float(values[-28:].mean()) * horizon
