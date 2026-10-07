import unittest

import pandas as pd

from rolling_practice import guard_reserved, past_groups
from weekly_forecasting import direct_training_frame


class RollingTests(unittest.TestCase):
    def test_reserved_products_are_rejected(self):
        with self.assertRaises(ValueError):
            guard_reserved(pd.DataFrame({"item_id": ["reserved"]}), ["reserved"])
        guard_reserved(pd.DataFrame({"item_id": ["development"]}), ["reserved"])

    def test_labels_stop_at_each_earlier_cutoff(self):
        data = pd.DataFrame({"date": pd.date_range("2014-01-01", periods=365),
                             "sales": 1., "store": 1, "item": 1})
        for cutoff in ["2014-06-30", "2014-09-30", "2014-12-31"]:
            for horizon in [7, 28]:
                frame = direct_training_frame(data.loc[data.date <= cutoff], horizon)
                self.assertLessEqual((frame.date + pd.Timedelta(days=horizon - 1)).max(), pd.Timestamp(cutoff))

    def test_pattern_uses_latest_available_history(self):
        data = pd.DataFrame({"date": pd.date_range("2014-01-01", periods=360),
                             "sales": [1.] * 180 + [0.] * 180, "item": 1})
        self.assertEqual(past_groups(data.iloc[:180])[1], "regular")
        self.assertEqual(past_groups(data)[1], "dormant")


if __name__ == "__main__":
    unittest.main()
