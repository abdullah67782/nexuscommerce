"""The sequential protocol's fixed content and the file lists whose hashes it freezes (shared by the freeze script
and the final runner, so both hash exactly the same files the same way)."""
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE3 = HERE.parent
REPO = STAGE3.parents[1]
OUT = STAGE3 / "outputs"
PROTOCOL = OUT / "seq_protocol.json"
PROTOCOL_ID = "nexus-stage3-seq-protocol-v1"

# Code: hashed after normalising CRLF to LF (a Windows checkout must not change the identity of unchanged code).
CODE = [
    "kaggle_training/stage3/sequential/replay.py", "kaggle_training/stage3/sequential/evaluate.py",
    "kaggle_training/stage3/sequential/seq_core.py", "kaggle_training/stage3/sequential/seq_data.py",
    "kaggle_training/stage3/sequential/seq_final_access.py", "kaggle_training/stage3/sequential/seq_final.py",
    "kaggle_training/stage3/sequential/seq_protocol_spec.py", "kaggle_training/stage3/sequential/engine_parity.js",
    "kaggle_training/stage3/sequential/seq_dev.py",
    "kaggle_training/stage3/final/common.py", "kaggle_training/stage3/served.py", "kaggle_training/stage3/data_access.py",
    "kaggle_training/stage3/events.py", "kaggle_training/stage3/u2_artifacts.py", "kaggle_training/stage3/e1_layer.py",
    "backend/lib/replenishment/engine.js",
    "ml/v2/forecast.py", "ml/v2/features.py", "ml/v2/methods.py", "ml/v2/registry.py",
    # text records also normalised (a Windows copy may carry CRLF)
    "ml/models_v2/manifest.json", "data/m5/calendar.csv",
]
# Data, models and frozen records: exact bytes.
EXACT = [
    "ml/models_v2/shared_total_7.json", "ml/models_v2/shared_total_28.json",
    "kaggle_training/stage3/outputs/final_protocol.json", "kaggle_training/stage3/outputs/reservation_m5.json",
    "kaggle_training/stage3/outputs/reservation_seq_m5.json",
    "data/m5/sales_train_evaluation.csv.zip", "data/m5/sell_prices.csv.zip",
]


def sha_file(path, normalise=False):
    data = Path(path).read_bytes()
    if normalise:
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def hashes():
    out = {p: sha_file(REPO / p, normalise=True) for p in CODE}
    out.update({p: sha_file(REPO / p) for p in EXACT})
    return out
