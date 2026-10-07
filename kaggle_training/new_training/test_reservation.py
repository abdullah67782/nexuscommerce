import unittest

import pandas as pd

from reserve_final_products import choose_products


class ReservationTests(unittest.TestCase):
    def setUp(self):
        self.catalog = pd.DataFrame({"item_id": [f"{category}_{i}" for category in ["A", "B"] for i in range(10)],
                                     "cat_id": [category for category in ["A", "B"] for _ in range(10)], "dept_id": "D"})

    def test_exclusion_and_category_balance(self):
        selected = choose_products(self.catalog, {"A_0", "B_0"}, per_category=3)
        self.assertEqual(len(selected), 6)
        self.assertFalse(set(selected.item_id) & {"A_0", "B_0"})
        self.assertTrue(selected.groupby("cat_id").size().eq(3).all())

    def test_selection_does_not_depend_on_row_order(self):
        a = choose_products(self.catalog, set(), per_category=3)
        b = choose_products(self.catalog.sample(frac=1, random_state=8), set(), per_category=3)
        pd.testing.assert_frame_equal(a, b)

    def test_duplicate_store_catalog_rows_do_not_duplicate_items(self):
        selected = choose_products(pd.concat([self.catalog, self.catalog]), set(), per_category=3)
        self.assertEqual(selected.item_id.nunique(), 6)


if __name__ == "__main__":
    unittest.main()
