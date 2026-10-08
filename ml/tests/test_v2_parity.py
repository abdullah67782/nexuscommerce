"""v2 must compute exactly what the approved experiment computed.

1. Feature parity: ml/v2/features.origin_features versus the experiment's own
   weekly_features() (kaggle_training/new_training) on varied synthetic series.
2. Method parity: TSB / SBA rates, sales-pattern groups and the 28-day mean.
3. Frozen replay: the predictions saved by the frozen evaluation
   (outputs/reserved_final_results/predictions.csv, produced with pandas 2.2.2 /
   xgboost 3.4.1) are reproduced from the frozen models through the v2 code.
   Skipped when the M5 files are not on this machine (data/m5 is not in git).

Run from ml/:  python -m unittest tests.test_v2_parity -v
"""
from datetime import date, timedelta
import json
import os
import sys
import unittest
from pathlib import Path

import numpy as np

ML = Path(__file__).resolve().parents[1]
ROOT = ML.parent
EXPERIMENT = ROOT / "kaggle_training" / "new_training"
sys.path.insert(0, str(ML))
sys.path.insert(1, str(EXPERIMENT))

from v2.features import FEATURES, origin_features  # noqa: E402
from v2 import methods  # noqa: E402
from v2.forecast import forecast_totals, shared_model_total  # noqa: E402

try:
    import pandas as pd
    import xgboost  # noqa: F401  (the experiment modules import it)
    import weekly_forecasting as experiment
    import analyze_sales_patterns as patterns
except ImportError as exc:  # pragma: no cover
    experiment = None
    SKIP_REASON = f"experiment code not importable: {exc}"
else:
    SKIP_REASON = ""


def synthetic_series(seed):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(56, 400))
    kind = seed % 5
    if kind == 0:   # regular
        values = rng.poisson(rng.uniform(2, 30), n)
    elif kind == 1:  # rare
        values = rng.poisson(5, n) * (rng.random(n) < 0.08)
    elif kind == 2:  # occasional with spikes
        values = rng.poisson(3, n) * (rng.random(n) < 0.5) + (rng.random(n) < 0.01) * 200
    elif kind == 3:  # long trailing zero run
        values = rng.poisson(4, n)
        values[-int(rng.integers(1, 55)):] = 0
    else:            # nothing sold at all
        values = np.zeros(n, dtype=int)
    start = date(2014, 1, 1) + timedelta(days=int(rng.integers(0, 700)))
    return start, values.astype(float)


@unittest.skipIf(experiment is None, SKIP_REASON)
class FeatureParity(unittest.TestCase):
    def test_origin_features_match_experiment(self):
        for seed in range(60):
            start, values = synthetic_series(seed)
            origin = start + timedelta(days=len(values))
            dates = pd.date_range(start, periods=len(values), freq="D")
            series = pd.DataFrame({"date": dates, "sales": values})
            extended = pd.concat([series, pd.DataFrame({"date": [pd.Timestamp(origin)], "sales": [0.]})], ignore_index=True)
            expected = experiment.weekly_features(extended).iloc[-1]
            self.assertEqual(list(expected[FEATURES].index), FEATURES)
            got = origin_features(values, origin)
            np.testing.assert_allclose(got, expected[FEATURES].to_numpy(dtype=float), rtol=1e-9, atol=1e-12,
                                       err_msg=f"seed {seed}")
            self.assertAlmostEqual(float(values[-28:].mean()) + 1, float(expected["scale"]), places=9)

    def test_feature_list_matches_frozen_protocol(self):
        protocol = json.loads((EXPERIMENT / "outputs/frozen_final_protocol/protocol.json").read_text())
        self.assertEqual(protocol["features"]["7"], FEATURES)
        self.assertEqual(protocol["features"]["28"], FEATURES)

    def test_methods_match_experiment(self):
        for seed in range(60):
            _, values = synthetic_series(seed)
            self.assertEqual(methods.intermittent_rates(values), experiment.intermittent_rates(values))
            fraction = pd.Series(values).tail(180).gt(0).mean()
            self.assertEqual(methods.planning_group(methods.selling_fraction(values)), patterns.planning_group(fraction))
        for fraction in [0, 0.001, 0.1999, 0.2, 0.5, 0.7999, 0.8, 1]:
            self.assertEqual(methods.planning_group(fraction), patterns.planning_group(fraction))

    def test_routes_match_frozen_protocol(self):
        protocol = json.loads((EXPERIMENT / "outputs/frozen_final_protocol/protocol.json").read_text())
        names = {"direct_general": "shared_model", "tsb": "tsb"}
        for route in protocol["routes"]:
            self.assertEqual(methods.ROUTE[route["pattern"]], names[route["selected_method"]])


M5 = ROOT / "data" / "m5"
FROZEN = EXPERIMENT / "outputs" / "frozen_final_protocol"
SAVED = EXPERIMENT / "outputs" / "reserved_final_results" / "predictions.csv"
HAVE_REPLAY = experiment is not None and (M5 / "calendar.csv").exists() and SAVED.exists()


@unittest.skipUnless(HAVE_REPLAY, "M5 data or frozen evaluation outputs not present")
class FrozenReplay(unittest.TestCase):
    """Re-forecast saved rows through the v2 code with the frozen per-store models."""

    @classmethod
    def setUpClass(cls):
        import xgboost as xgb
        from reserved_final_evaluation import read_reserved

        protocol = json.loads((FROZEN / "protocol.json").read_text())
        protocol["sources"] = {"calendar": {"path": str(M5 / "calendar.csv")},
                               "sales": {"path": str(M5 / "sales_train_evaluation.csv.zip")},
                               "prices": {"path": str(M5 / "sell_prices.csv.zip")}}
        cls.data, _ = read_reserved(protocol)
        cls.saved = pd.read_csv(SAVED, parse_dates=["origin"])
        cls.models = {}
        for store in protocol["target_stores"]:
            for horizon in protocol["horizons"]:
                booster = xgb.Booster()
                booster.load_model(str(FROZEN / "models" / store / f"direct_general_{horizon}.json"))
                cls.models[store, horizon] = booster

    def replay(self, rows):
        checked = 0
        for _, row in rows.iterrows():
            series = self.data.loc[(self.data.store_id == row.store) & (self.data["item"] == row["item"])
                                   & (self.data.date < row.origin)].sort_values("date")
            values = series.sales.to_numpy(dtype=float)
            origin = row.origin.date()
            if row.method == "direct_general":
                got = shared_model_total(self.models[row.store, row.horizon], values, origin, row.horizon)
            elif row.method == "tsb":
                got = methods.tsb_total(values, row.horizon)
            elif row.method == "mean_28":
                got = methods.mean_28_total(values, row.horizon)
            else:
                continue
            self.assertAlmostEqual(got, row.predicted, delta=1e-4 * max(1.0, abs(row.predicted)),
                                   msg=f"{row.store} {row.item_id} {row.origin.date()} h{row.horizon} {row.method}")
            self.assertEqual(methods.planning_group(methods.selling_fraction(values)), row.pattern)
            checked += 1
        return checked

    def test_first_and_last_windows_reproduce(self):
        rows = self.saved.loc[self.saved.method.isin(["direct_general", "tsb", "mean_28"])]
        edges = rows.groupby(["store", "horizon"]).origin.agg(["min", "max"]).reset_index()
        picked = rows.merge(edges, on=["store", "horizon"])
        picked = picked.loc[(picked.origin == picked["min"]) | (picked.origin == picked["max"])]
        self.assertGreater(self.replay(picked), 900)

    def test_routed_rule_matches_v2_selection(self):
        # The frozen rule's choice per row equals what forecast_totals would choose
        # for a model-tier history (every replayed history has >= 180 days).
        routed = self.saved.loc[self.saved.method == "cautious_group_route"]
        expected = {"rare": "tsb"}
        for _, row in routed.head(400).iterrows():
            self.assertEqual(row.selected_method, "tsb" if expected.get(row.pattern) == "tsb" else "direct_general")


class Tiers(unittest.TestCase):
    def test_tier_boundaries(self):
        start = date(2026, 1, 1)
        for days, tier in [(0, "insufficient"), (27, "insufficient"), (28, "average"), (179, "average")]:
            result = forecast_totals(start, [2.0] * days)
            self.assertEqual(result["history"]["tier"], tier)
        self.assertEqual(forecast_totals(start, [2.0] * 27)["forecasts"], [])
        self.assertEqual(forecast_totals(start, [2.0] * 27)["status"], "insufficient_history")

    def test_average_tier_is_28_day_mean(self):
        values = [0.0] * 20 + [1, 2, 3, 4] * 7  # last 28 days average 2.5
        result = forecast_totals(date(2026, 3, 1), values)
        self.assertEqual(result["status"], "ok")
        totals = {f["horizon_days"]: f["total_units"] for f in result["forecasts"]}
        self.assertEqual(totals, {7: 17.5, 28: 70.0})
        self.assertEqual({f["method"] for f in result["forecasts"]}, {"average_28"})
        first = result["forecasts"][0]
        self.assertEqual((first["start"], first["end"]), ("2026-04-18", "2026-04-24"))

    def test_rare_model_tier_uses_tsb_without_models(self):
        values = ([0.0] * 9 + [3.0]) * 20  # 10% selling days -> rare
        result = forecast_totals(date(2025, 1, 1), values)
        self.assertEqual(result["pattern"]["group"], "rare")
        self.assertEqual({f["method"] for f in result["forecasts"]}, {"tsb"})
        self.assertAlmostEqual(result["forecasts"][0]["total_units"], methods.tsb_total(values, 7))

    def test_regular_model_tier_requires_models(self):
        with self.assertRaises(RuntimeError):
            forecast_totals(date(2025, 1, 1), [5.0] * 200)

    def test_rejects_invalid_quantities(self):
        for bad in ([1, -1] * 20, [1, float("nan")] * 20):
            with self.assertRaises(ValueError):
                forecast_totals(date(2025, 1, 1), bad)


if __name__ == "__main__":
    unittest.main()
