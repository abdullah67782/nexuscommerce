import unittest

import pandas as pd

from cautious_routing import apply_routes, candidate_evidence


class RoutingTests(unittest.TestCase):
    def cells(self):
        rows = []
        for fold, windows in [("winter", 3), ("spring", 2), ("summer", 3)]:
            for store in ["A", "B", "C"]:
                for method, error in [("direct_general", 100.), ("tsb", 90.)]:
                    rows.append(dict(fold=fold, store=store, horizon=28, pattern="rare", method=method,
                                     absolute_error_units=error, actual_units=100., products=12, windows=windows))
        return pd.DataFrame(rows)

    def test_consistent_meaningful_gain_passes(self):
        result = candidate_evidence(self.cells(), 28, "rare", "tsb")
        self.assertTrue(result["eligible"])
        self.assertEqual(result["winning_cells"], 9)

    def test_aggregate_gain_cannot_hide_a_bad_fold(self):
        cells = self.cells()
        cells.loc[(cells.method == "tsb") & (cells.fold != "summer"), "absolute_error_units"] = 70.
        cells.loc[(cells.method == "tsb") & (cells.fold == "summer"), "absolute_error_units"] = 101.
        result = candidate_evidence(cells, 28, "rare", "tsb")
        self.assertGreater(result["pooled_gain_percent"], 5)
        self.assertFalse(result["eligible"])

    def test_small_groups_or_missing_periods_do_not_pass(self):
        cells = self.cells()
        cells["products"] = 2
        self.assertFalse(candidate_evidence(cells, 28, "rare", "tsb")["eligible"])
        self.assertFalse(candidate_evidence(self.cells().loc[lambda d: d.fold != "winter"], 28, "rare", "tsb")["eligible"])

    def test_routing_does_not_depend_on_actual_outcomes(self):
        rows = pd.DataFrame({"store": ["A", "A"], "horizon": [7, 7], "origin": ["2015-09-01"] * 2,
                             "item": [1, 1], "pattern": ["rare", "rare"],
                             "method": ["direct_general", "tsb"], "predicted": [10., 5.], "actual": [1., 1.]})
        routes = pd.DataFrame({"horizon": [7], "pattern": ["rare"], "selected_method": ["tsb"]})
        first = apply_routes(rows, routes)
        rows["actual"] = 1000.
        second = apply_routes(rows, routes)
        self.assertEqual(first.predicted.tolist(), second.predicted.tolist())
        self.assertEqual(first.selected_method.tolist(), second.selected_method.tolist())


if __name__ == "__main__":
    unittest.main()
