"""Small M5 fixture: check format conversion, launch trimming and day alignment."""
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from m5_adapter import adapt_m5


class M5AdapterTests(unittest.TestCase):
    def test_wide_sales_map_to_dates_and_prelaunch_rows_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dates = pd.date_range("2013-01-01", "2014-03-31")
            calendar = pd.DataFrame({"date": dates, "d": [f"d_{i + 1}" for i in range(len(dates))],
                                     "wm_yr_wk": [i // 7 for i in range(len(dates))]})
            calendar.to_csv(root / "calendar.csv", index=False)
            sales, prices = [], []
            for store in ["CA_1", "TX_1"]:
                launch_week = 2 if store == "CA_1" else 4
                row = {"item_id": "FOODS_1_001", "dept_id": "FOODS_1", "cat_id": "FOODS", "store_id": store, "state_id": store[:2]}
                row.update({day: (0 if i < launch_week * 7 else i % 5) for i, day in enumerate(calendar.d)})
                sales.append(row)
                for week in range(launch_week, len(dates) // 7 + 1):
                    prices.append({"store_id": store, "item_id": "FOODS_1_001", "wm_yr_wk": week, "sell_price": 2.5})
            pd.DataFrame(sales).to_csv(root / "sales.csv", index=False)
            pd.DataFrame(prices).to_csv(root / "prices.csv", index=False)
            data, details = adapt_m5(root / "calendar.csv", root / "sales.csv", root / "prices.csv",
                                     items_per_category=1, train_end="2013-12-31", test_end="2014-03-31")
            self.assertEqual(data.loc[data.store_id == "CA_1", "date"].min(), dates[14])
            self.assertEqual(data.loc[data.store_id == "TX_1", "date"].min(), dates[28])
            self.assertEqual(data.date.max(), dates[-1])
            self.assertTrue((data.sales == 0).any())  # Keep real zero sales after launch.
            row = data.loc[(data.store_id == "CA_1") & (data.date == dates[20])].iloc[0]
            self.assertEqual(row.sales, 20 % 5)
            self.assertEqual(details["store_mapping"], {"CA_1": 1, "TX_1": 2})


if __name__ == "__main__":
    unittest.main()
