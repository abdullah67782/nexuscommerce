"""Check date alignment, leakage protection and baseline recursion without training."""
import unittest

import numpy as np
import pandas as pd

from store_personalization import Config, features_for_series, forecast_baselines, select_methods


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.history = pd.DataFrame({"date": pd.date_range("2020-01-01", periods=90), "sales": np.arange(90, dtype=float)})

    def test_current_and_future_sales_do_not_change_inputs(self):
        altered = self.history.copy()
        altered.loc[60:, "sales"] = 1000000
        original = features_for_series(self.history).loc[60].drop("target")
        changed = features_for_series(altered).loc[60].drop("target")
        pd.testing.assert_series_equal(original, changed)

    def test_next_day_lag_contains_last_observation(self):
        next_date = self.history.date.iloc[-1] + pd.Timedelta(days=1)
        extended = pd.concat([self.history, pd.DataFrame({"date": [next_date], "sales": [0.]})], ignore_index=True)
        row = features_for_series(extended).iloc[-1]
        self.assertAlmostEqual(row.lag_1_relative * row.scale, 89.)
        self.assertEqual(row.day_of_week, next_date.dayofweek)

    def test_zero_sales_features_are_finite(self):
        history = self.history.assign(sales=0.)
        row = features_for_series(history).iloc[-1]
        self.assertTrue(np.isfinite(row).all())

    def test_baseline_repeats_week_without_future_actuals(self):
        result = forecast_baselines(self.history.assign(item=1), 14)
        seasonal = result.loc[result.method == "seasonal_naive", "predicted"].to_numpy()
        np.testing.assert_array_equal(seasonal[:7], seasonal[7:])
        self.assertEqual(result.date.min(), self.history.date.max() + pd.Timedelta(days=1))

    def test_personalization_requires_validation_improvement(self):
        metrics = pd.DataFrame({"horizon": [7] * 4, "method": ["general", "personalized", "seasonal_naive", "moving_average"],
                                "WAPE_percent": [10., 9.9, 12., 14.]})
        self.assertEqual(select_methods(metrics, Config())[7], "general")
        metrics.loc[metrics.method == "personalized", "WAPE_percent"] = 9.
        self.assertEqual(select_methods(metrics, Config())[7], "personalized")


if __name__ == "__main__":
    unittest.main()
