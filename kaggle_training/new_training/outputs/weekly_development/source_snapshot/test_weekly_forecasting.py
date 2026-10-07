import unittest

import numpy as np
import pandas as pd

from weekly_forecasting import direct_training_frame, intermittent_rates, weekly_features, select_routes


class WeeklyTests(unittest.TestCase):
    def history(self):
        return pd.DataFrame({"date": pd.date_range("2015-01-01", periods=120), "sales": np.arange(120, dtype=float), "store": 1, "item": 1})

    def test_inputs_ignore_current_and_future_sales(self):
        original = self.history()
        changed = original.copy()
        changed.loc[80:, "sales"] = 1000000
        pd.testing.assert_series_equal(weekly_features(original).loc[80].drop("target"),
                                       weekly_features(changed).loc[80].drop("target"))

    def test_direct_target_is_next_week_total(self):
        data = self.history()
        frame = direct_training_frame(data, 7)
        row = frame.loc[frame.date == data.date.iloc[80]].iloc[0]
        self.assertAlmostEqual(row.target * row.scale * 7, sum(range(80, 87)))
        self.assertLessEqual(frame.date.max() + pd.Timedelta(days=6), data.date.max())

    def test_tsb_decays_after_no_sales(self):
        frequent = intermittent_rates([2] * 100)[1]
        declining = intermittent_rates([2] * 100 + [0] * 100)[1]
        self.assertLess(declining, frequent / 100)
        self.assertEqual(intermittent_rates([0] * 100), (0., 0.))

    def test_latest_sale_gap_is_one_day(self):
        row = weekly_features(self.history()).iloc[-1]
        self.assertEqual(row.days_since_sale, 1)

    def test_four_week_routing_uses_store_fallback(self):
        rows = []
        for item in [1, 2]:
            for i in range(3):
                for method, prediction in [("mean_7", 4), ("mean_28", 3), ("tsb", 2)]:
                    rows.append({"item": item, "item_id": str(item), "origin": i, "pattern": "rare", "method": method,
                                 "actual": 2 if item == 1 else 4, "predicted": prediction})
        routes = select_routes(pd.DataFrame(rows))
        self.assertTrue((routes.selection_reason == "store_fallback").all())


if __name__ == "__main__":
    unittest.main()
