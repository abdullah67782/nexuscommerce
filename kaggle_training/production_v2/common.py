"""Shared paths and helpers for the v2 production-model workflow.

Workflow (each step refuses to run twice or out of order):
  1. reserve_holdout.py      metadata-only selection of fresh holdout products
  2. train_production.py     two shared models (7 and 28 days), fixed recipe
  3. freeze_evaluation.py    protocol with model, code and reservation hashes
  4. evaluate_production.py  one evaluation of the frozen models on the holdout
"""
from pathlib import Path
import hashlib
import json
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXPERIMENT = ROOT / "kaggle_training" / "new_training"
FROZEN = EXPERIMENT / "outputs" / "frozen_final_protocol"
M5 = ROOT / "data" / "m5"
OUTPUT = HERE / "outputs"
MODELS_V2 = ROOT / "ml" / "models_v2"

for path in (str(EXPERIMENT), str(ROOT / "ml")):
    if path not in sys.path:
        sys.path.insert(0, path)

TRAINING_END = "2015-05-31"
EVALUATION_START = "2015-12-01"
EVALUATION_END = "2016-05-22"
HORIZONS = [7, 28]

# The fixed recipe: the frozen protocol's general model, unchanged
# (store_personalization.new_model(250, Config())).
RECIPE = {"n_estimators": 250, "max_depth": 5, "learning_rate": 0.04, "min_child_weight": 10,
          "subsample": 0.85, "colsample_bytree": 0.9, "reg_lambda": 5,
          "objective": "reg:squarederror", "tree_method": "hist", "n_jobs": 4, "random_state": 42}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def m5_paths():
    return M5 / "calendar.csv", M5 / "sales_train_evaluation.csv.zip", M5 / "sell_prices.csv.zip"


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, default=str) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def versions():
    import platform
    import numpy as np
    import pandas as pd
    import xgboost as xgb
    return {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__, "xgboost": xgb.__version__}
