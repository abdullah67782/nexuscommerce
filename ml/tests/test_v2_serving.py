"""v2 serving: only the approved artifacts load, and they reproduce known forecasts.

- The registry loads ml/models_v2 files listed in the manifest, verifies hashes,
  feature names and tree counts, and refuses tampered or foreign files.
- No v2 code path can read the legacy pickles in ml/models.
- The fixture holds forecasts computed where the models were trained; this test
  must pass in the application's runtime (the Windows venv) before v2 is used.

Run from ml/:  python -m unittest tests.test_v2_serving -v
"""
from datetime import date
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from v2 import registry  # noqa: E402
from v2.forecast import forecast_totals  # noqa: E402

FIXTURE = json.loads((ML / "tests/fixtures/v2_serving_fixture.json").read_text())


class Registry(unittest.TestCase):
    def copy_models(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        for item in registry.MODELS_V2_DIR.iterdir():
            shutil.copy2(item, folder / item.name)
        return folder

    def test_loads_only_manifest_models(self):
        models, manifest = registry.load_models()
        self.assertEqual(sorted(models), [7, 28])
        self.assertEqual(manifest["release"], FIXTURE["models_release"])

    def test_tampered_model_is_refused(self):
        folder = self.copy_models()
        target = folder / "shared_total_7.json"
        target.write_text(target.read_text().replace('"', '"', 1) + " ")
        with self.assertRaisesRegex(registry.ModelRegistryError, "does not match its manifest hash"):
            registry.load_models(folder)

    def test_manifest_cannot_point_outside_models_v2_or_at_pickles(self):
        for bad in ["../models/xgb_finetuned_3.pkl", "xgb_finetuned_3.pkl", "sub/model.json"]:
            folder = self.copy_models()
            manifest = json.loads((folder / "manifest.json").read_text())
            manifest["models"]["7"]["file"] = bad
            (folder / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(registry.ModelRegistryError, "plain .json name"):
                registry.load_models(folder)

    def test_feature_contract_mismatch_is_refused(self):
        folder = self.copy_models()
        manifest = json.loads((folder / "manifest.json").read_text())
        manifest["features"] = manifest["features"][:-1]
        (folder / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(registry.ModelRegistryError, "feature contract"):
            registry.load_models(folder)

    def test_missing_manifest_is_refused(self):
        with self.assertRaisesRegex(registry.ModelRegistryError, "manifest not found"):
            registry.load_models(tempfile.mkdtemp())

    def test_v2_code_never_references_legacy_artifacts(self):
        import ast
        for path in (ML / "v2").glob("*.py"):
            tree = ast.parse(path.read_text())
            docstrings = {id(node.body[0].value) for node in ast.walk(tree)
                          if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body
                          and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant)}
            imported, strings = set(), []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported |= {alias.name.split(".")[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.split(".")[0])
                elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                    strings.append(node.value)
            self.assertFalse(imported & {"pickle", "joblib", "model_loader", "forecaster", "finetune"}, path.name)
            for text in strings:
                self.assertNotIn(".pkl", text, path.name)
                self.assertNotIn("finetuned", text, path.name)


class ServingFixture(unittest.TestCase):
    def test_reproduces_fixture_forecasts(self):
        models, _ = registry.load_models()
        groups = set()
        for case in FIXTURE["cases"]:
            result = forecast_totals(date.fromisoformat(case["start"]), case["quantities"], models)
            groups.add(result["pattern"]["group"])
            for forecast in result["forecasts"]:
                expected = case["expected"][str(forecast["horizon_days"])]
                self.assertEqual(forecast["method"], expected["method"])
                self.assertEqual((forecast["start"], forecast["end"]), (expected["start"], expected["end"]))
                self.assertAlmostEqual(forecast["total_units"], expected["total_units"],
                                       delta=1e-4 * max(1.0, expected["total_units"]))
        self.assertEqual(groups, {"regular", "occasional", "rare", "dormant"})


if __name__ == "__main__":
    unittest.main()
