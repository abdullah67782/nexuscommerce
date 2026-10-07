"""Run the predefined M5-subset experiment locally, with CPU and separate outputs."""
from pathlib import Path
import json
import platform
import shutil
import sys
import time

import numpy as np
import pandas as pd
import xgboost as xgb

from m5_adapter import adapt_m5, locate_m5, save_m5_metadata
from run_additional_stores_local import Tee
from store_personalization import Config, run_experiment


def main():
    output_root = Path(__file__).resolve().parent / "outputs/m5_cpu"
    output_root.mkdir(parents=True, exist_ok=True)
    if (output_root / "run_complete.json").exists():
        raise FileExistsError("Completed M5 run already exists; preserve it rather than overwriting.")
    started = time.perf_counter()
    console = sys.stdout
    with (output_root / "run.log").open("w", encoding="utf-8") as logfile:
        sys.stdout = Tee(console, logfile)
        try:
            paths = locate_m5()
            print("Inputs:", paths, flush=True)
            data, details = adapt_m5(*paths, items_per_category=20)
            save_m5_metadata(details, output_root)
            print("Store mapping:", details["store_mapping"], flush=True)
            print("Predefined M5 subset: 250 general + 80 adaptation trees, 4 CPU threads.", flush=True)
            all_metrics = []
            for store_name in ["CA_1", "TX_1", "WI_1"]:
                print("\nTARGET STORE", store_name, flush=True)
                config = Config(target_store=details["store_mapping"][store_name], train_end="2015-05-31",
                                validation_end="2015-11-30", test_end="2016-05-22")
                run_dir = output_root / store_name
                validation, final_test, selection = run_experiment(data, run_dir, config)
                manifest_path = run_dir / "manifest.json"
                manifest = json.loads(manifest_path.read_text())
                manifest.update(dataset="M5 subset", target_store_name=store_name,
                                training_countries="US retail stores; no cross-country claim",
                                scope="Predefined subset and held-out stores; not an official full M5 benchmark.")
                manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                for period, table in [("validation", validation), ("final_test", final_test)]:
                    all_metrics.append(table.assign(target_store=store_name, period=period))
                print("Elapsed minutes:", round((time.perf_counter() - started) / 60, 2), flush=True)
            summary = pd.concat(all_metrics, ignore_index=True)
            summary.to_csv(output_root / "all_store_metrics.csv", index=False)
            comparison = summary.loc[summary.period == "final_test"].pivot(
                index=["target_store", "horizon"], columns="method", values="WAPE_percent")
            comparison["personalization_gain_relative_percent"] = 100 * (comparison.general - comparison.personalized) / comparison.general
            comparison.to_csv(output_root / "personalization_comparison.csv")
            print("\nFINAL COMPARISON\n", comparison.round(3).to_string(), flush=True)
            metadata = {"elapsed_seconds": time.perf_counter() - started, "python": platform.python_version(),
                        "xgboost": xgb.__version__, "pandas": pd.__version__, "numpy": np.__version__,
                        "target_stores": ["CA_1", "TX_1", "WI_1"], "subset_run": True,
                        "items_per_category_requested": 20, "eligible_items": data.item.nunique()}
            (output_root / "run_complete.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        finally:
            sys.stdout = console
    archive = shutil.make_archive(str(output_root), "zip", output_root)
    print("Completed. Archive:", archive, flush=True)


if __name__ == "__main__":
    main()
