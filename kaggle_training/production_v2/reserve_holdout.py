"""Step 1: reserve a FRESH holdout for evaluating the v2 production models.

Reads catalog columns only (item_id, cat_id, dept_id, store_id, state_id); no
sales-day column (d_1 ... d_1941) is parsed. Excludes every product used or
examined before: the 60 originally sampled candidates (which include the 53
development products) and the 60 products of the first reserved holdout, whose
sales were examined in the October 6 final evaluation. Products are ranked by a
stable hash of a new seed, so the choice cannot depend on sales, errors,
availability or package versions.
"""
import hashlib

import numpy as np
import pandas as pd

from common import FROZEN, OUTPUT, m5_paths, read_json, sha256, write_json

SEED = "nexus-production-holdout-20261008-v1"
PER_CATEGORY = 20
CATALOG_COLUMNS = ["item_id", "dept_id", "cat_id", "store_id", "state_id"]


def prior_candidates(catalog, development):
    """Recreate the original seeded sample (before its availability filter)."""
    rng = np.random.default_rng(development["sampling_seed"])
    items = catalog[["item_id", "cat_id"]].drop_duplicates().sort_values("item_id")
    chosen = []
    for _, group in items.groupby("cat_id", sort=True):
        chosen.extend(rng.choice(group.item_id.to_numpy(), size=development["requested_items_per_category"], replace=False).tolist())
    return chosen


def choose(catalog, excluded, seed=SEED, per_category=PER_CATEGORY):
    items = catalog[["item_id", "cat_id", "dept_id"]].drop_duplicates().sort_values("item_id")
    if items.item_id.duplicated().any():
        raise ValueError("Inconsistent category/department for an item.")
    available = items.loc[~items.item_id.isin(excluded)].copy()
    available["selection_hash"] = available.item_id.map(lambda item: hashlib.sha256(f"{seed}|{item}".encode()).hexdigest())
    selected = available.sort_values(["cat_id", "selection_hash"]).groupby("cat_id", sort=True).head(per_category)
    if not selected.groupby("cat_id").size().eq(per_category).all():
        raise ValueError("Not enough unexamined products in a category.")
    return selected.sort_values(["cat_id", "item_id"]).reset_index(drop=True)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / "holdout_reservation.json"
    if path.exists():
        raise FileExistsError("Holdout already reserved. Preserve it; never redraw.")
    _, sales_path, _ = m5_paths()
    catalog = pd.read_csv(sales_path, usecols=CATALOG_COLUMNS)  # metadata columns only
    development = read_json(FROZEN / "metadata" / "development_sample.json")
    first_holdout = read_json(FROZEN / "metadata" / "reservation.json")["selected_products"]
    candidates = prior_candidates(catalog, development)
    assert set(development["selected_items"]) <= set(candidates)
    excluded = set(candidates) | set(development["selected_items"]) | set(first_holdout)
    selected = choose(catalog, excluded)
    assert not set(selected.item_id) & excluded
    selected.to_csv(OUTPUT / "holdout_products.csv", index=False)
    pairs = catalog.loc[catalog.item_id.isin(selected.item_id), CATALOG_COLUMNS].sort_values(["item_id", "store_id"])
    pairs.to_csv(OUTPUT / "holdout_product_store_pairs.csv", index=False)
    write_json(path, {
        "reservation_id": SEED,
        "status": "reserved_before_any_sales_were_read",
        "purpose": "One-time evaluation of the two v2 production models (7- and 28-day totals).",
        "selected_products": selected.item_id.tolist(),
        "products": len(selected), "categories": selected.groupby("cat_id").size().to_dict(),
        "store_product_pairs": len(pairs), "stores": sorted(pairs.store_id.unique().tolist()),
        "excluded": {"original_sample_candidates": len(candidates), "development_products": len(development["selected_items"]),
                     "first_reserved_holdout_already_examined": len(first_holdout), "total_distinct": len(excluded)},
        "excluded_products": sorted(excluded),
        "selection_inputs": ["item_id", "cat_id", "dept_id"], "sales_columns_parsed": False,
        "source_sales_file": sales_path.name, "source_sha256": sha256(sales_path),
        "rules": [
            "Never train, tune or select methods on these products.",
            "Freeze the production models and the evaluation protocol before reading any of their sales.",
            "Evaluate once; keep every result, including losses and exclusions; never replace products.",
            "Any later change to models or rules needs another fresh holdout."],
        "limits": "Unseen products within the same US retail chain (M5). Not a new business, country or Pakistan-store validation.",
    })
    print("Reserved", len(selected), "products,", len(pairs), "store/product pairs; excluded", len(excluded), "prior products.")


if __name__ == "__main__":
    main()
