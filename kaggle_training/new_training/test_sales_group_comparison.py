import unittest

import pandas as pd

from compare_sales_groups import group_score, validate_predictions


class SalesGroupTests(unittest.TestCase):
    def test_zero_sale_errors_stay_in_main_score(self):
        rows = pd.DataFrame({"store": ["A", "A"], "item_id": ["selling", "zero"],
                             "origin": ["2015-01-01"] * 2, "actual": [10., 0.], "predicted": [10., 5.]})
        result = group_score(rows)
        self.assertEqual(result["WAPE_percent"], 50.)
        self.assertEqual(result["zero_total_products"], 1)
        self.assertEqual(result["median_product_WAPE_percent"], 0.)
        self.assertEqual(result["predicted_units_on_zero_actual_windows"], 5.)

    def test_all_zero_volume_has_undefined_wape(self):
        rows = pd.DataFrame({"store": ["A"], "item_id": ["zero"], "origin": ["2015-01-01"],
                             "actual": [0.], "predicted": [5.]})
        self.assertTrue(pd.isna(group_score(rows)["WAPE_percent"]))
        self.assertEqual(group_score(rows)["absolute_error_units"], 5.)

    def fixture(self):
        return pd.DataFrame({"fold": ["winter"] * 6, "store": ["A"] * 6, "horizon": [7] * 6,
                             "origin": ["2015-01-01"] * 6, "item": [1] * 6,
                             "method": [f"method{i}" for i in range(6)], "actual": [10.] * 6,
                             "predicted": [10.] * 6, "pattern": ["regular"] * 6})

    def test_inconsistent_groups_or_quantities_are_rejected(self):
        for column, value in [("pattern", "rare"), ("actual", 20.)]:
            rows = self.fixture()
            rows.loc[0, column] = value
            with self.assertRaises(ValueError):
                validate_predictions(rows)

    def test_missing_method_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_predictions(self.fixture().iloc[:-1])


if __name__ == "__main__":
    unittest.main()
