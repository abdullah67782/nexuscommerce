import unittest

import pandas as pd

from analyze_sales_patterns import longest_zero_streak, planning_group, summarize_series


class PatternTests(unittest.TestCase):
    def history(self, sales):
        return pd.DataFrame({"date": pd.date_range(end="2015-05-31", periods=len(sales)), "sales": sales,
                             "store_id": "CA_1", "item_id": "FOODS_1_001", "cat_id": "FOODS", "state_id": "CA"})

    def test_threshold_boundaries(self):
        self.assertEqual(planning_group(0), "dormant")
        self.assertEqual(planning_group(.19), "rare")
        self.assertEqual(planning_group(.20), "occasional")
        self.assertEqual(planning_group(.80), "regular")

    def test_weekly_blocks_keep_zero_days_but_aggregate_sales(self):
        result = summarize_series(self.history([0, 0, 0, 0, 0, 0, 2] * 2))
        self.assertEqual(result["complete_week_blocks"], 2)
        self.assertEqual(result["zero_week_percent"], 0)
        self.assertAlmostEqual(result["zero_day_percent"], 100 * 6 / 7)
        self.assertEqual(result["longest_zero_run_days"], 6)

    def test_dormant_series_has_no_invented_positive_sales(self):
        result = summarize_series(self.history([0] * 180))
        self.assertEqual(result["planning_group"], "dormant")
        self.assertEqual(result["zero_week_percent"], 100)
        self.assertEqual(result["days_since_last_sale"], 180)

    def test_validation_dates_are_rejected(self):
        data = self.history([1] * 30)
        data.loc[data.index[-1], "date"] = pd.Timestamp("2015-06-01")
        with self.assertRaises(ValueError):
            summarize_series(data)

    def test_longest_streak(self):
        self.assertEqual(longest_zero_streak([0, 0, 1, 0, 0, 0, 2]), 3)


if __name__ == "__main__":
    unittest.main()
