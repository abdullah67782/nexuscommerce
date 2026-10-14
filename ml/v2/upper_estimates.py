"""One-sided upper demand estimates, version upper-estimates-1 (approved release, architect 2026-10-13).

What this is: for a product's 7- and 28-day forecast total, an 80% and a 90% UPPER estimate of demand, computed
with the exact method that passed the one-time Stage 3 final evaluation for the product's sales pattern. The
final evaluation checked one thing per cell: how often actual demand was at or below the estimate in US Walmart
benchmark data (M5). So this is never a two-sided range, a guarantee or an order quantity, and there is no
lower estimate.

What it never does: change the forecast. The forecast (tier, pattern group, method and total) is computed by
v2.forecast.forecast_totals exactly as /v2/forecast does, and returned unchanged beside the estimates.

Approved cells (12): regular, occasional and rare products x 7/28 days x 80/90%. Everything else gets an
'unavailable' reason and only the forecast: dormant products, fewer than 180 confirmed days, a model release
other than the evaluated one, or a route other than the evaluated one. Market and store/product applicability
are enforced by the backend before it calls this service.

Methods (frozen research code kaggle_training/stage3/final/common.py and u2_artifacts.py, restated here):
  U0  upper = max(0, (F + 1) x q0 - 1)            q0 = benchmark ratio quantile for the cell
  U1  upper = max(0, F + q1 x sqrt(F + 1))         q1 = benchmark score quantile for the cell
  U2  upper = max(0, (b(x) + c) x (F + 1) - 1)     b = stored quantile booster, c = conformal correction,
                                                    x = [v2 origin features, log1p F, history days, selling fraction 180]
  U3  TSB bootstrap: k ~ Binomial(h, p_TSB) sales, sizes drawn from the last 180 days' positive sales,
      400 draws, upper = the level's quantile of the simulated totals. The draws are seeded from the request,
      so the same history always gives the same estimate.
Artifacts: ml/upper_estimates_v1 (calibration_us.json and U2_h7_p0.8.json copied byte-for-byte from the frozen
Stage 3 artifacts; policy.json from the consumed final evaluation), every file hash-checked against manifest.json.
"""
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np

from .features import origin_features
from .forecast import forecast_totals
from .methods import GROUP_WINDOW_DAYS, selling_fraction

ARTIFACT_DIR = Path(os.environ.get("UPPER_ESTIMATES_DIR", Path(__file__).resolve().parents[1] / "upper_estimates_v1"))
VERSION = "upper-estimates-1"
LEVELS = (0.8, 0.9)
U3_DRAWS = 400
U3_BETA = 0.1
U3_SIZE_DAYS = 180

REASONS = {
    "no_forecast": "There is no forecast for this product yet, so there is no upper estimate.",
    "short_history": "Upper estimates need at least 180 confirmed days of history. Products with less history could "
                     "not be validated in the benchmark (only 86 windows from 11 products), so only the forecast is shown.",
    "dormant": "This product has had no sales in the last 180 days. No upper-estimate method met the benchmark checks "
               "for such products, so only the forecast is shown.",
    "release_not_evaluated": "The forecast model release in use is not the release that was evaluated, so upper "
                             "estimates are switched off and only the forecast is shown.",
    "route_not_evaluated": "This forecast used a method other than the one evaluated for its sales pattern, so only "
                           "the forecast is shown.",
}


class UpperEstimatesError(RuntimeError):
    pass


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_artifacts(directory=None):
    """Hash-checked artifacts: {'policy', 'manifest', 'booster'}. Raises UpperEstimatesError on any mismatch."""
    import xgboost as xgb

    directory = Path(directory or ARTIFACT_DIR)
    mpath = directory / "manifest.json"
    if not mpath.is_file():
        raise UpperEstimatesError(f"upper-estimate manifest not found in {directory}")
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    if manifest.get("version") != VERSION:
        raise UpperEstimatesError(f"artifacts are {manifest.get('version')}, this service is {VERSION}")
    for name, digest in manifest.get("files", {}).items():
        if Path(name).name != name:
            raise UpperEstimatesError(f"artifact name must be a plain file name: {name}")
        if not (directory / name).is_file() or _sha256(directory / name) != digest:
            raise UpperEstimatesError(f"artifact {name} is missing or does not match its manifest hash")
    if set(manifest.get("files", {})) != {"calibration_us.json", "U2_h7_p0.8.json", "policy.json"}:
        raise UpperEstimatesError("the manifest must list exactly the approved artifacts")
    if xgb.__version__.split(".")[:2] != str(manifest.get("xgboost_version", "")).split(".")[:2]:
        raise UpperEstimatesError(f"booster built with xgboost {manifest.get('xgboost_version')}, runtime is {xgb.__version__}")
    policy = json.loads((directory / "policy.json").read_text(encoding="utf-8"))
    calib = json.loads((directory / "calibration_us.json").read_text(encoding="utf-8"))
    if len(policy.get("cells", {})) != 12:
        raise UpperEstimatesError("the policy must contain exactly the 12 approved cells")
    for key, cell in policy["cells"].items():   # parameters must equal the frozen calibration, value for value
        par = cell["parameter"]
        frozen = {"U0": lambda: {"ratio_quantile": calib["U0"][key]}, "U1": lambda: {"score_quantile": calib["U1"][key]},
                  "U2": lambda: {"booster": "U2_h7_p0.8.json", "correction": calib["U2_correction"][key]},
                  "U3": lambda: {"draws": U3_DRAWS, "history_days_for_sizes": U3_SIZE_DAYS, "beta": U3_BETA}}[cell["method"]]()
        if par != frozen:
            raise UpperEstimatesError(f"{key}: policy parameter differs from the frozen calibration")
    booster = xgb.Booster()
    booster.load_model(str(directory / "U2_h7_p0.8.json"))
    return {"policy": policy, "manifest": manifest, "booster": booster}


_cache = {}


def get_artifacts():
    if "a" not in _cache:
        _cache["a"] = load_artifacts()
    return _cache["a"]


def clear_cache():
    _cache.clear()


# ── methods ──────────────────────────────────────────────────────────────────
def u0(F, q):
    return max((F + 1.0) * q - 1.0, 0.0)


def u1(F, q):
    return max(F + q * math.sqrt(F + 1.0), 0.0)


def u2_features(values, origin, F):
    """[v2 origin features (float32, as served), log1p(F), history days, selling fraction over 180 days]."""
    x = origin_features(values, origin).astype(np.float32)
    days = len(values)
    w = min(days, GROUP_WINDOW_DAYS)
    frac = float(np.sum(values[days - w:] > 0)) / w
    return np.column_stack([x.reshape(1, -1), np.array([[np.log1p(F)]]), np.array([[float(days)]]), np.array([[frac]])])


def u2(booster, values, origin, F, correction):
    q = booster.inplace_predict(u2_features(values, origin, F))
    return float(np.maximum((q[0] + correction) * (F + 1.0) - 1.0, 0.0))


def tsb_probability(values):
    pos = np.flatnonzero(values > 0)
    if not len(pos):
        return 0.0
    first = pos[0]
    prob = 1 / (first + 1)
    for q in values[first + 1:]:
        prob += U3_BETA * (float(q > 0) - prob)
    return prob


def u3_seed(start, values, horizon):
    h = hashlib.sha256(f"{VERSION}|{start.isoformat()}|{horizon}|".encode())
    h.update(np.asarray(values, dtype="<f8").tobytes())
    return int.from_bytes(h.digest()[:8], "little")


def u3(values, horizon, rng):
    """{level: upper} from one set of draws (both levels share the draws, as evaluated)."""
    prob = tsb_probability(values)
    hist = values[max(0, len(values) - U3_SIZE_DAYS):]
    sizes = hist[hist > 0]
    if not len(sizes) or prob <= 0:
        return {p: 0.0 for p in LEVELS}
    k = rng.binomial(int(horizon), prob, size=U3_DRAWS)
    tot = np.array([rng.choice(sizes, size=kk).sum() if kk else 0.0 for kk in k])
    return {p: float(np.quantile(tot, p)) for p in LEVELS}


# ── service ──────────────────────────────────────────────────────────────────
def applicability(forecast, release, policy):
    """None when the evaluated conditions hold, else a reason code."""
    if forecast.get("status") != "ok" or not forecast.get("forecasts"):
        return "no_forecast"
    if forecast["history"]["tier"] != "model" or forecast["history"]["usable_days"] < policy["min_history_days"]:
        return "short_history"
    group = (forecast.get("pattern") or {}).get("group")
    if group == "dormant":
        return "dormant"
    if release != policy["evaluated_release"]:
        return "release_not_evaluated"
    route = policy["evaluated_routes"].get(group)
    if route is None or any(f["method"] != route for f in forecast["forecasts"]):
        return "route_not_evaluated"
    return None


def upper_estimates(start, quantities, models, release, artifacts):
    """Forecast (unchanged) plus one-sided upper estimates, or an unavailable reason."""
    forecast = forecast_totals(start, quantities, models)
    forecast["models_release"] = release
    policy = artifacts["policy"]
    out = {"version": VERSION, "policy_version": policy["policy_version"], "kind": policy["kind"],
           "forecast": forecast, "estimates": [], "limitations": policy["limitations"], "benchmark": policy["benchmark"]}
    reason = applicability(forecast, release, policy)
    if reason:
        out.update(status="unavailable", reason={"code": reason, "text": REASONS[reason]})
        return out
    values = np.asarray(quantities, dtype=float)
    group = forecast["pattern"]["group"]
    from datetime import date
    for f in forecast["forecasts"]:
        h, F = f["horizon_days"], f["total_units"]
        origin = date.fromisoformat(f["start"])
        sim = None
        for p in LEVELS:
            key = f"{group}|{h}|{p}"
            cell = policy["cells"][key]
            m, par = cell["method"], cell["parameter"]
            if m == "U0":
                up = u0(F, par["ratio_quantile"])
            elif m == "U1":
                up = u1(F, par["score_quantile"])
            elif m == "U2":
                up = u2(artifacts["booster"], values, origin, F, par["correction"])
            else:
                if sim is None:
                    sim = u3(values, h, np.random.default_rng(u3_seed(start, values, h)))
                up = sim[p]
            out["estimates"].append({
                "horizon_days": h, "start": f["start"], "end": f["end"], "level": p, "cell": key,
                "upper_units": up, "forecast_units": F, "method": m, "method_label": cell["method_label"],
                "benchmark": cell["benchmark"],
            })
    out["status"] = "available"
    out["reason"] = None
    return out
