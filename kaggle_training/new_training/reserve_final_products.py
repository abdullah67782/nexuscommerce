"""Reserve a product holdout without inspecting any sales values.

Only catalog columns are parsed. Both the 53 previously evaluated items and all
60 originally sampled candidates are excluded. Stable hash ranking avoids
selection based on sales volume, forecast error, availability or package version.
"""
from pathlib import Path
import hashlib
import json

import numpy as np
import pandas as pd

from m5_adapter import locate_m5

SEED = "nexus-final-products-20261006-v1"
PER_CATEGORY = 20


def choose_products(catalog, excluded, per_category=PER_CATEGORY, seed=SEED):
    items = catalog[["item_id", "cat_id", "dept_id"]].drop_duplicates().sort_values("item_id")
    if items.item_id.duplicated().any():
        raise ValueError("Inconsistent category/department for an item.")
    available = items.loc[~items.item_id.isin(excluded)].copy()
    available["selection_hash"] = available.item_id.map(lambda item: hashlib.sha256(f"{seed}|{item}".encode()).hexdigest())
    selected = available.sort_values(["cat_id", "selection_hash"]).groupby("cat_id", sort=True).head(per_category)
    if not selected.groupby("cat_id").size().eq(per_category).all():
        raise ValueError("Not enough unexamined products in a category.")
    return selected.sort_values(["cat_id", "item_id"]).reset_index(drop=True)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    root = Path(__file__).resolve().parent
    output = root / "outputs/reserved_final_test"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "reservation.json"
    if manifest_path.exists():
        raise FileExistsError("Reservation already exists. Preserve it; do not draw a new sample.")
    _, sales_path, _ = locate_m5()
    # No d_1...d_1941 sales columns are parsed or summarized.
    catalog = pd.read_csv(sales_path, usecols=["item_id", "cat_id", "dept_id", "store_id", "state_id"])
    original = json.loads((root / "outputs/m5_cpu/m5_data_manifest.json").read_text())
    rng = np.random.default_rng(original["sampling_seed"])
    items = catalog[["item_id", "cat_id"]].drop_duplicates().sort_values("item_id")
    prior_candidates = []
    for _, group in items.groupby("cat_id", sort=True):
        prior_candidates.extend(rng.choice(group.item_id.to_numpy(), size=original["requested_items_per_category"], replace=False).tolist())
    excluded = set(prior_candidates) | set(original["selected_items"])
    selected = choose_products(catalog, excluded)
    assert not set(selected.item_id) & excluded
    selected.to_csv(output / "reserved_products.csv", index=False)
    series = catalog.loc[catalog.item_id.isin(selected.item_id)].sort_values(["item_id", "store_id"])
    series.to_csv(output / "reserved_product_store_ids.csv", index=False)
    manifest = {
        "reservation_id": SEED, "status": "sealed_for_development", "items_per_category": PER_CATEGORY,
        "selected_products": selected.item_id.tolist(), "excluded_prior_candidates": sorted(excluded),
        "products": len(selected), "potential_store_product_histories": len(series),
        "categories": selected.groupby("cat_id").size().to_dict(),
        "source_sales_file": str(sales_path), "source_sha256": file_hash(sales_path),
        "selection_inputs": ["item_id", "cat_id", "dept_id"],
        "sales_inspected_for_selection": False,
        "primary_target_stores": ["CA_1", "TX_1", "WI_1"],
        "planned_training_end": "2015-05-31", "planned_evaluation_start": "2015-12-01",
        "planned_evaluation_end": "2016-05-22", "planned_horizons": [7, 28],
        "protocol": [
            "Exclude every reserved product from all stores during model development and method selection.",
            "Freeze model code, settings and group-selection policy before opening reserved product sales.",
            "At final evaluation, earlier target-product history may supply forecast inputs and predefined personalization through the training cutoff only.",
            "Any personalized candidate training on reserved history occurs only after protocol freeze; no reserved forecast errors select or tune methods.",
            "Determine history availability using past dates/first price metadata only, with >=180 calendar days available before the training cutoff.",
            "Report all reserved products, eligibility, exclusions, zero-sales outcomes and cold-start cases. Never replace weak products with new picks.",
            "Score complete non-overlapping windows ending within the evaluation period and report exact scored dates.",
            "Keep final results separate from development results. Any later tuning requires another fresh evaluation."
        ],
        "limits": "New product holdout within the same M5 retail chain, not a new independent business or country dataset. Reservation is a protocol safeguard, not encryption or filesystem access control."
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("Reserved", len(selected), "products across", series.store_id.nunique(), "stores:", len(series), "potential histories.")
    print("Categories:", manifest["categories"])
    print("Excluded all", len(excluded), "prior candidates; sales columns were not parsed.")
    print("Saved to", output)


if __name__ == "__main__":
    main()
