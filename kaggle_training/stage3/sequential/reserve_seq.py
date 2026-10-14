"""Reservation for the sequential inventory evaluation (metadata only). Run once.

Draws, seeded and per category, 150 M5 products (50 FOODS, 50 HOBBIES, 50 HOUSEHOLD) from the products that no earlier
stage has read: not the forecasting work (consumed 180, incl. the 53 training products and both earlier holdouts),
not Stage 3 development (development_extra 150) and not the Stage 3 final holdout (90). Only catalog columns
(item_id, cat_id) are read; no sales and no prices. All 10 stores of each product are reserved. The products are
sealed: seq_data refuses them for development; only seq_final_access reads them, once, behind the run lock.
Refuses to overwrite an existing reservation.
"""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import data_access as D  # noqa: E402

RESERVATION_ID = "nexus-stage3-seq-m5-v1"
PATH = D.STAGE3 / "outputs" / "reservation_seq_m5.json"
PER_CATEGORY = 50


def main():
    if PATH.exists():
        raise SystemExit("The sequential reservation already exists; it is never redrawn.")
    stage3 = json.loads(D.RESERVATION.read_text())
    read_before = sorted(set(stage3["consumed_products"]) | set(stage3["development_extra_products"]) | set(stage3["holdout_products"]))
    catalog = D.m5_catalog()[["item_id", "cat_id"]].drop_duplicates().sort_values("item_id")
    pool = catalog.loc[~catalog.item_id.isin(read_before)]
    seed = int(hashlib.sha256(RESERVATION_ID.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    chosen = []
    for _, group in pool.groupby("cat_id", sort=True):
        chosen.extend(sorted(rng.permutation(group.item_id.to_numpy())[:PER_CATEGORY].tolist()))
    assert not set(chosen) & set(read_before) and len(chosen) == 3 * PER_CATEGORY
    record = {
        "reservation_id": RESERVATION_ID, "status": "reserved_before_any_sales_were_read",
        "selection_inputs": ["item_id", "cat_id"], "sales_or_prices_read": False,
        "seed_rule": f"int(sha256('{RESERVATION_ID}')[:8], 16) = {seed}",
        "source_sales_file_sha256": D.sha256(D.M5_DIR / "sales_train_evaluation.csv.zip"),
        "source_prices_file_sha256": D.sha256(D.M5_DIR / "sell_prices.csv.zip"),
        "excluded_read_before": len(read_before), "pool": int(len(pool)), "per_category": PER_CATEGORY,
        "products": chosen, "stores": "all 10",
        "final_replay": ["2015-11-23", "2016-05-22"],
        "rules": ["Never read before the frozen one-time final run (seq_data refuses them).",
                  "Series with fewer than 28 days of history at the replay start are excluded and reported, never replaced."],
        "made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    PATH.write_text(json.dumps(record, indent=2) + "\n")
    print({k: (len(v) if isinstance(v, list) else v) for k, v in record.items()})


if __name__ == "__main__":
    main()
