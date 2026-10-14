"""upper-estimates-1: artifact-to-API parity, eligibility boundaries, fallback and integrity.

1. Artifacts: only the hash-checked approved files load; a changed file, an extra or missing file, or a policy
   parameter that differs from the frozen calibration is refused.
2. Parity: the fixture (made with the frozen research code on development M5 series,
   kaggle_training/stage3/final/make_upper_estimates_fixture.py) is reproduced by the service:
   U0/U1/U2 within 1e-9 units, U3 exactly; the forecast inside the response equals /v2/forecast's.
3. Eligibility boundaries: 179 vs 180 days, the 20% / 80% selling-fraction edges, dormant, release and route
   mismatches. Every unavailable case still returns the unchanged forecast.
4. The HTTP endpoint (skipped where FastAPI is not installed).

Run from ml/:  python -m unittest tests.test_upper_estimates -v
"""
from datetime import date, timedelta
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from v2 import upper_estimates as UE  # noqa: E402
from v2.forecast import forecast_totals  # noqa: E402
from v2.registry import get_models  # noqa: E402

FIXTURE = json.loads((ML / "tests/fixtures/upper_estimates_fixture.json").read_text())
START = date(2015, 1, 1)


def series(n, sell_days=None, q=3.0):
    """n days; the last 180 days sell on exactly `sell_days` days (spread evenly)."""
    v = np.full(n, q)
    if sell_days is not None:
        last = np.zeros(180)
        if sell_days:
            last[np.linspace(0, 179, sell_days).round().astype(int)] = q
        v[-180:] = last
    return v


class Artifacts(unittest.TestCase):
    def copy(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        for item in UE.ARTIFACT_DIR.iterdir():
            shutil.copy2(item, folder / item.name)
        return folder

    def rehash(self, folder):
        m = json.loads((folder / "manifest.json").read_text())
        m["files"] = {n: UE._sha256(folder / n) for n in m["files"]}
        (folder / "manifest.json").write_text(json.dumps(m))

    def test_loads_the_twelve_approved_cells(self):
        a = UE.load_artifacts()
        self.assertEqual(len(a["policy"]["cells"]), 12)
        self.assertEqual({k.split("|")[0] for k in a["policy"]["cells"]}, {"regular", "occasional", "rare"})
        self.assertEqual(a["policy"]["evaluated_release"], "nexus-v2-shared-20261008")
        self.assertEqual(a["manifest"]["files"]["calibration_us.json"],
                         "fc73f5d2b592a282d774f0d3b6d5a22797d872c586a8ed0db955a6e9d4742d12", "frozen laptop calibration")
        self.assertEqual(a["manifest"]["files"]["U2_h7_p0.8.json"],
                         "2153c5d9aae68badd65f8abdc6b4821b6da5513f7649a1f80a9d17996296df27", "selected U2 booster")

    def test_changed_file_is_refused(self):
        folder = self.copy()
        (folder / "policy.json").write_text((folder / "policy.json").read_text() + " ")
        with self.assertRaisesRegex(UE.UpperEstimatesError, "does not match its manifest hash"):
            UE.load_artifacts(folder)

    def test_parameter_must_equal_frozen_calibration(self):
        folder = self.copy()
        p = json.loads((folder / "policy.json").read_text())
        p["cells"]["regular|7|0.8"]["parameter"]["ratio_quantile"] += 1e-12
        (folder / "policy.json").write_text(json.dumps(p))
        self.rehash(folder)
        with self.assertRaisesRegex(UE.UpperEstimatesError, "differs from the frozen calibration"):
            UE.load_artifacts(folder)

    def test_extra_or_missing_cells_are_refused(self):
        folder = self.copy()
        p = json.loads((folder / "policy.json").read_text())
        p["cells"]["dormant|28|0.9"] = dict(p["cells"]["regular|28|0.9"])
        (folder / "policy.json").write_text(json.dumps(p))
        self.rehash(folder)
        with self.assertRaisesRegex(UE.UpperEstimatesError, "exactly the 12 approved cells"):
            UE.load_artifacts(folder)


class Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models, manifest = get_models()
        cls.release = manifest["release"]
        cls.art = UE.load_artifacts()

    def test_fixture_reproduced(self):
        """Strict in the frozen runtime (numpy 1.26.4, as in the final evaluation's preflight P1). Under NumPy 2,
        float32 scalar arithmetic in the served forecast moves F by ~1e-7 relative (NEP 50), so there the check is
        relative and the strict check is reported as skipped."""
        worst = {"U0": 0.0, "U1": 0.0, "U2": 0.0, "U3": 0.0}
        worst_rel, worst_f = 0.0, 0.0
        seen = set()
        for case in FIXTURE["cases"]:
            start = date.fromisoformat(case["start"])
            r = UE.upper_estimates(start, case["quantities"], self.models, self.release, self.art)
            self.assertEqual(r["status"], "available", case["id"])
            plain = forecast_totals(start, case["quantities"], self.models)
            plain["models_release"] = self.release
            self.assertEqual(r["forecast"], plain, "the forecast is returned unchanged")
            self.assertEqual(r["forecast"]["pattern"]["group"], case["group"])
            got = {e["cell"]: e for e in r["estimates"]}
            self.assertEqual(set(got), set(case["expected"]))
            for cell, exp in case["expected"].items():
                e = got[cell]
                self.assertEqual(e["method"], exp["method"])
                worst_f = max(worst_f, abs(e["forecast_units"] - exp["F"]))
                d = abs(e["upper_units"] - exp["upper"])
                worst[exp["method"]] = max(worst[exp["method"]], d)
                worst_rel = max(worst_rel, d / (1.0 + abs(exp["upper"])))
                seen.add(cell)
        self.assertEqual(len(seen), 12, "every approved cell is exercised")
        self.assertEqual(worst["U3"], 0.0, "U3 reproduces the seeded draws exactly")
        print(f"\n  parity: worst |dF| {worst_f:.3g}; worst |d upper| {worst}; numpy {np.__version__}")
        if np.__version__ != "1.26.4":
            self.assertLess(worst_rel, 1e-6, worst)
            self.skipTest(f"strict 1e-9 parity is checked in the frozen runtime (numpy 1.26.4); here numpy {np.__version__}, "
                          f"relative difference {worst_rel:.2g}")
        self.assertLess(worst_f, 1e-9)
        self.assertLess(max(worst["U0"], worst["U1"], worst["U2"]), 1e-9, worst)

    def test_deterministic(self):
        case = next(c for c in FIXTURE["cases"] if c["group"] == "rare")
        start = date.fromisoformat(case["start"])
        a = UE.upper_estimates(start, case["quantities"], self.models, self.release, self.art)
        b = UE.upper_estimates(start, case["quantities"], self.models, self.release, self.art)
        self.assertEqual(a, b)

    def check(self, values, code, release=None):
        r = UE.upper_estimates(START, list(values), self.models if len(values) >= 180 else None,
                               release or (self.release if len(values) >= 180 else None), self.art)
        plain = forecast_totals(START, list(values), self.models if len(values) >= 180 else None)
        plain["models_release"] = release or (self.release if len(values) >= 180 else None)
        self.assertEqual(r["forecast"], plain, "the forecast is unchanged in every case")
        if code is None:
            self.assertEqual(r["status"], "available")
            self.assertEqual(len(r["estimates"]), 4)
        else:
            self.assertEqual((r["status"], r["reason"]["code"], r["estimates"]), ("unavailable", code, []))
        return r

    def test_history_boundary(self):
        self.check(series(27), "no_forecast")
        self.check(series(179), "short_history")
        self.check(series(180), None)

    def test_pattern_boundaries(self):
        r = self.check(series(400, sell_days=144), None)        # 144/180 = 0.80 -> regular
        self.assertEqual(r["forecast"]["pattern"]["group"], "regular")
        r = self.check(series(400, sell_days=143), None)        # < 0.80 -> occasional
        self.assertEqual(r["forecast"]["pattern"]["group"], "occasional")
        r = self.check(series(400, sell_days=36), None)         # 36/180 = 0.20 -> occasional
        self.assertEqual(r["forecast"]["pattern"]["group"], "occasional")
        r = self.check(series(400, sell_days=35), None)         # < 0.20 -> rare (TSB)
        self.assertEqual(r["forecast"]["pattern"]["group"], "rare")
        self.assertEqual({e["method"] for e in r["estimates"] if e["horizon_days"] == 7}, {"U3"})
        self.check(series(400, sell_days=0), "dormant")

    def test_release_and_route(self):
        self.check(series(400), "release_not_evaluated", release="some-other-release")
        forecast = forecast_totals(START, list(series(400)), self.models)
        forecast["forecasts"][0]["method"] = "tsb"
        self.assertEqual(UE.applicability(forecast, self.release, self.art["policy"]), "route_not_evaluated")

    def test_labels(self):
        r = self.check(series(400), None)
        self.assertEqual(r["kind"], "one-sided upper demand estimate")
        self.assertIn("Evaluated on US Walmart benchmark data; not calibrated to your store.", r["limitations"])
        for e in r["estimates"]:
            self.assertIn(e["level"], (0.8, 0.9))
            self.assertEqual(e["benchmark"]["target"], e["level"])
            self.assertNotIn("lower", json.dumps(e).lower())


try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import v2_api
except (ImportError, RuntimeError):  # pragma: no cover  (starlette needs httpx)
    TestClient = None


@unittest.skipIf(TestClient is None, "FastAPI test client not installed")
class Endpoint(unittest.TestCase):
    def test_endpoint_matches_service_and_forecast(self):
        app = FastAPI()
        app.include_router(v2_api.router)
        client = TestClient(app)
        case = FIXTURE["cases"][0]
        body = {"start": case["start"], "quantities": case["quantities"]}
        up = client.post("/v2/upper-estimates", json=body).json()
        fc = client.post("/v2/forecast", json=body).json()
        self.assertEqual(up["forecast"], fc)
        for e in up["estimates"]:
            self.assertLess(abs(e["upper_units"] - case["expected"][e["cell"]]["upper"]), 1e-9)
        short = client.post("/v2/upper-estimates", json={"start": "2015-01-01", "quantities": [1.0] * 100}).json()
        self.assertEqual((short["status"], short["reason"]["code"]), ("unavailable", "short_history"))


if __name__ == "__main__":
    unittest.main()
