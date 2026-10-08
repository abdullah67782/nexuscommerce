"""Loads the approved v2 production models — and nothing else.

Only files listed in ml/models_v2/manifest.json are loaded, from that folder
only, and only when their SHA-256 matches the manifest. Legacy models in
ml/models (xgb_<country>.pkl, xgb_finetuned_<seller>.pkl) are never read here:
this module has no code path that opens a pickle or a seller-specific file.
"""
import hashlib
import json
import os
from pathlib import Path

from .features import FEATURES

MODELS_V2_DIR = Path(os.environ.get("MODELS_V2_DIR", Path(__file__).resolve().parents[1] / "models_v2"))
HORIZONS = (7, 28)


class ModelRegistryError(RuntimeError):
    pass


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(directory=None):
    directory = Path(directory or MODELS_V2_DIR)
    path = directory / "manifest.json"
    if not path.is_file():
        raise ModelRegistryError(f"v2 manifest not found in {directory}")
    return directory, json.loads(path.read_text(encoding="utf-8"))


def load_models(directory=None):
    """Return ({horizon: Booster}, manifest). Raises ModelRegistryError on any mismatch."""
    import xgboost as xgb

    directory, manifest = load_manifest(directory)
    if manifest.get("features") != FEATURES:
        raise ModelRegistryError("manifest features differ from the v2 feature contract")
    runtime = xgb.__version__.split(".")[:2]
    built = str(manifest.get("xgboost_version", "")).split(".")[:2]
    if runtime != built:
        raise ModelRegistryError(f"models built with xgboost {manifest.get('xgboost_version')}, runtime is {xgb.__version__}")
    models = {}
    for horizon in HORIZONS:
        entry = manifest.get("models", {}).get(str(horizon))
        if not entry:
            raise ModelRegistryError(f"manifest has no {horizon}-day model")
        name = entry["file"]
        if Path(name).name != name or not name.endswith(".json"):
            raise ModelRegistryError(f"model file must be a plain .json name inside models_v2: {name}")
        path = directory / name
        if not path.is_file():
            raise ModelRegistryError(f"missing model file {name}")
        if _sha256(path) != entry["sha256"]:
            raise ModelRegistryError(f"model file {name} does not match its manifest hash")
        booster = xgb.Booster()
        booster.load_model(str(path))
        if booster.feature_names != FEATURES:
            raise ModelRegistryError(f"{name}: feature names differ from the v2 contract")
        if booster.num_boosted_rounds() != entry["trees"]:
            raise ModelRegistryError(f"{name}: expected {entry['trees']} trees")
        models[horizon] = booster
    return models, manifest


_cache = {}


def get_models():
    """Cached load; a failed load is not cached, so fixing the files and retrying works."""
    if "models" not in _cache:
        _cache["models"] = load_models()
    return _cache["models"]


def clear_cache():
    _cache.clear()
