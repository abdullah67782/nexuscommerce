"""Research-only copies of the v2 shared models with EARLIER cutoffs (dev protocol: R12, R13, R14).

Same recipe and code path as kaggle_training/production_v2/train_production.py:
  * the 53 v2 development products (from the production manifest), all 10 stores;
  * eligibility: first price <= cutoff - 180 days in every store;
  * weekly_forecasting.direct_training_frame on data <= cutoff, so every target window
    ends on or before the cutoff (checked);
  * store_personalization.new_model(250, Config()) with the RECIPE check.
Models go to kaggle_training/stage3/outputs/research_models/ — never to ml/models_v2.
Existing copies are kept (resumable); a changed recipe or code refuses.
"""
import json
import sys
from pathlib import Path

import pandas as pd

import data_access as D

sys.path[:0] = [str(D.ROOT / "kaggle_training" / "new_training"), str(D.ROOT / "kaggle_training" / "production_v2"),
                str(D.ROOT / "ml")]
from common import RECIPE  # noqa: E402
from store_personalization import Config, new_model  # noqa: E402
from weekly_forecasting import direct_training_frame  # noqa: E402
from v2.features import FEATURES  # noqa: E402

OUT = D.STAGE3 / "outputs" / "research_models"
CUTOFFS = {"R12": "2012-05-31", "R13": "2013-05-31", "R14": "2014-05-31"}


def training_data(cutoff):
    manifest = json.loads((D.ROOT / "ml" / "models_v2" / "manifest.json").read_text())
    products = manifest["training"]["products"]
    launches = D.m5_launch_dates(products)
    launches = launches.loc[launches.launch_date <= pd.Timestamp(cutoff) - pd.Timedelta(days=180)]
    counts = launches.groupby("item_id").store_id.nunique()
    chosen = sorted(counts.loc[counts == 10].index)
    long = D.m5_daily(chosen, cutoff)
    long = long.merge(launches, on=["store_id", "item_id"], how="inner")
    long = long.loc[long.date >= long.launch_date].drop(columns=["launch_date"])
    stores = {s: i + 1 for i, s in enumerate(sorted(long.store_id.unique()))}
    items = {s: i + 1 for i, s in enumerate(chosen)}
    data = long.assign(store=long.store_id.map(stores), item=long.item_id.map(items))
    data = data[["date", "store", "item", "sales"]].sort_values(["store", "item", "date"]).reset_index(drop=True)
    return data, chosen


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    for name, cutoff in CUTOFFS.items():
        if name in index:
            print("kept", name, flush=True)
            continue
        data, chosen = training_data(cutoff)
        if data.date.max() > pd.Timestamp(cutoff):
            raise AssertionError("training data passes the cutoff")
        entry = {"cutoff": cutoff, "products": len(chosen), "product_ids": chosen, "series": int(data.groupby(["store", "item"]).ngroups),
                 "rows_daily": int(len(data)), "models": {}}
        for h in (7, 28):
            frame = direct_training_frame(data, h)
            features = [c for c in frame if c not in ["scale", "target", "store", "item", "date"]]
            if features != FEATURES:
                raise AssertionError("feature contract changed")
            last_label = frame.date.max()
            if last_label + pd.Timedelta(days=h - 1) > pd.Timestamp(cutoff):
                raise AssertionError("a target window ends after the cutoff")
            model = new_model(250, Config())
            if {k: model.get_params()[k] for k in RECIPE} != RECIPE:
                raise AssertionError("recipe drift")
            model.fit(frame[features].astype("float32"), frame.target.astype("float32"))
            path = OUT / f"{name}_{h}.json"
            model.save_model(path)
            entry["models"][str(h)] = {"file": path.name, "sha256": D.sha256(path), "training_rows": int(len(frame)),
                                       "first_label_date": str(frame.date.min().date()),
                                       "last_label_date": str(last_label.date()),
                                       "last_target_day": str((last_label + pd.Timedelta(days=h - 1)).date())}
            print(name, h, entry["models"][str(h)], flush=True)
        index[name] = entry
        index_path.write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
