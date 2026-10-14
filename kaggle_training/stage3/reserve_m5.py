"""Stage 3 M5 reservation (metadata only). Run once from the repository root.

From the M5 products never used by earlier work, draws (seeded, per category):
  * 90 FINAL HOLDOUT products (30 per category) — sealed until the final evaluation;
  * 150 additional DEVELOPMENT products (50 per category), disjoint from the holdout.
Only catalog columns (item_id, cat_id) are read. No sales or prices are read.
Eligibility (first price >= 180 days before the relevant cutoff) is decided later from
earlier availability only; ineligible pairs are excluded and reported, never replaced.
Refuses to overwrite an existing reservation.
"""
import hashlib
import json
from datetime import datetime, timezone

import numpy as np

import data_access as D

RESERVATION_ID = "nexus-stage3-m5-v1"


def main():
    if D.RESERVATION.exists():
        raise SystemExit("Reservation already exists; it is never redrawn.")
    previous = json.loads((D.ROOT / "kaggle_training" / "production_v2" / "outputs" / "holdout_reservation.json").read_text())
    consumed = sorted(set(previous["excluded_products"]) | set(previous["selected_products"]))
    catalog = D.m5_catalog()[["item_id", "cat_id"]].drop_duplicates().sort_values("item_id")
    unused = catalog.loc[~catalog.item_id.isin(consumed)]
    seed = int(hashlib.sha256(RESERVATION_ID.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    holdout, development = [], []
    for category, group in unused.groupby("cat_id", sort=True):
        items = group.item_id.to_numpy()
        draw = rng.permutation(items)
        holdout.extend(sorted(draw[:30].tolist()))
        development.extend(sorted(draw[30:80].tolist()))
    assert not set(holdout) & set(development) and not (set(holdout) | set(development)) & set(consumed)
    D.RESERVATION.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "reservation_id": RESERVATION_ID, "status": "reserved_before_any_sales_were_read",
        "selection_inputs": ["item_id", "cat_id"], "sales_or_prices_read": False,
        "seed_rule": f"int(sha256('{RESERVATION_ID}')[:8], 16) = {seed}",
        "source_sales_file_sha256": D.sha256(D.M5_DIR / "sales_train_evaluation.csv.zip"),
        "consumed_products_excluded": len(consumed), "unused_pool": int(len(unused)),
        "holdout_products": sorted(holdout), "development_extra_products": sorted(development),
        "consumed_products": consumed,
        "rules": ["Holdout products are never read before the frozen final evaluation (data_access refuses them).",
                  "Development uses consumed + development_extra products only.",
                  "Eligibility from earlier availability only; exclusions reported, never replaced."],
        "made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    D.RESERVATION.write_text(json.dumps(record, indent=2) + "\n")
    print({k: (len(v) if isinstance(v, list) else v) for k, v in record.items()})


if __name__ == "__main__":
    main()
