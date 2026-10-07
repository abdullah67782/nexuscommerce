from pathlib import Path
import json
import platform
import tempfile
import unittest

import numpy as np
import pandas as pd
import xgboost as xgb

from reserved_final_evaluation import eligibility_table, evaluate_store, sha256, verify_bundle
from weekly_forecasting import weekly_features


class ConstantModel:
    def predict(self, matrix):
        return np.full(len(matrix), .5)


class FinalProtocolTests(unittest.TestCase):
    def test_eligibility_uses_availability_not_sales(self):
        cutoff = pd.Timestamp("2015-05-31")
        catalog = pd.DataFrame({"store_id": ["A"] * 3, "item_id": ["old", "new", "no_price"]})
        launches = pd.DataFrame({"store_id": ["A"] * 2, "item_id": ["old", "new"],
                                 "launch_date": [cutoff - pd.Timedelta(days=180), cutoff - pd.Timedelta(days=179)]})
        result = eligibility_table(catalog, launches, ["old", "new", "no_price", "missing"], ["A"], cutoff).set_index("item_id")
        self.assertTrue(result.loc["old", "eligible"])
        self.assertFalse(result.loc["new", "eligible"])
        self.assertEqual(result.loc["no_price", "reason"], "no_price_availability_date")
        self.assertEqual(result.loc["missing", "reason"], "missing_catalog_pair")
        self.assertEqual(len(result), 4)

    def fixture(self):
        return pd.DataFrame({"date": pd.date_range("2015-01-01", periods=90), "sales": [1.] * 90,
                             "item": 1, "item_id": "synthetic_only"})

    def test_final_forecasts_do_not_see_future_actual_sales(self):
        data = self.fixture()
        features = [c for c in weekly_features(data) if c not in ["target", "scale"]]
        routes = {p: "direct_general" for p in ["regular", "occasional", "rare", "dormant"]}
        models = {"direct_general": ConstantModel(), "direct_personalized": ConstantModel()}
        original, dates = evaluate_store(data, 7, models, features, routes, "2015-03-15", "2015-03-21")
        data.loc[data.date >= "2015-03-15", "sales"] = 1000.
        changed, _ = evaluate_store(data, 7, models, features, routes, "2015-03-15", "2015-03-21")
        np.testing.assert_allclose(original.predicted, changed.predicted)
        self.assertEqual(dates[0]["window_end"], pd.Timestamp("2015-03-21"))
        self.assertEqual(len(original), 7)  # Six candidates plus one fixed route.

    def test_incomplete_final_window_fails_instead_of_dropping(self):
        data = self.fixture().loc[lambda d: d.date != "2015-03-20"]
        features = [c for c in weekly_features(data) if c not in ["target", "scale"]]
        routes = {p: "direct_general" for p in ["regular", "occasional", "rare", "dormant"]}
        with self.assertRaises(ValueError):
            evaluate_store(data, 7, {"direct_general": ConstantModel()}, features, routes, "2015-03-15", "2015-03-21")

    def test_changed_frozen_artifact_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder)
            artifact = bundle / "dummy.txt"
            artifact.write_text("frozen")
            protocol = {"artifact_hashes": {"dummy.txt": sha256(artifact)}, "sources": {},
                        "versions": {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__, "xgboost": xgb.__version__}}
            (bundle / "protocol.json").write_text(json.dumps(protocol))
            (bundle / "protocol.sha256").write_text(sha256(bundle / "protocol.json"))
            verify_bundle(bundle)
            artifact.write_text("changed")
            with self.assertRaises(ValueError):
                verify_bundle(bundle)


if __name__ == "__main__":
    unittest.main()
