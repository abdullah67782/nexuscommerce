"""Run the same predefined Kaggle experiment locally on CPU."""
from pathlib import Path
import json
import platform
import shutil
import sys
import time

import numpy as np
import pandas as pd
import xgboost as xgb

from store_personalization import Config, load_data, locate_data, run_experiment


class Tee:
    def __init__(self, console, logfile):
        self.console, self.logfile = console, logfile

    def write(self, text):
        self.console.write(text)
        self.logfile.write(text)
        self.logfile.flush()

    def flush(self):
        self.console.flush()
        self.logfile.flush()


def main():
    root = Path(__file__).resolve().parent
    output_root = root / "outputs/additional_stores_cpu"
    output_root.mkdir(parents=True, exist_ok=True)
    if (output_root / "run_complete.json").exists():
        raise FileExistsError("A completed run already exists; preserve it instead of overwriting.")
    started = time.perf_counter()
    console = sys.stdout
    with (output_root / "run.log").open("w", encoding="utf-8") as logfile:
        sys.stdout = Tee(console, logfile)
        try:
            data_path = locate_data()
            data = load_data(data_path)
            print("Dataset:", data_path, "rows:", len(data), flush=True)
            print("Full CPU experiment; stores 1 and 5; 250 general + 80 adaptation trees; 4 threads.", flush=True)
            all_metrics = []
            for target_store in [1, 5]:
                print("\nTARGET STORE", target_store, flush=True)
                config = Config(target_store=target_store)
                validation, final_test, selection = run_experiment(data, output_root / f"store_{target_store}", config)
                for period, table in [("validation", validation), ("final_test", final_test)]:
                    all_metrics.append(table.assign(target_store=target_store, period=period))
                print("Elapsed minutes:", round((time.perf_counter() - started) / 60, 2), flush=True)
            summary = pd.concat(all_metrics, ignore_index=True)
            summary.to_csv(output_root / "all_store_metrics.csv", index=False)
            comparison = summary.loc[summary.period == "final_test"].pivot(
                index=["target_store", "horizon"], columns="method", values="WAPE_percent")
            comparison["personalization_gain_relative_percent"] = 100 * (comparison.general - comparison.personalized) / comparison.general
            comparison.to_csv(output_root / "personalization_comparison.csv")
            print("\nFINAL COMPARISON\n", comparison.round(4).to_string(), flush=True)
            metadata = {"elapsed_seconds": time.perf_counter() - started, "python": platform.python_version(),
                        "xgboost": xgb.__version__, "pandas": pd.__version__, "numpy": np.__version__,
                        "target_stores": [1, 5], "data_path": str(data_path), "full_run": True}
            (output_root / "run_complete.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        finally:
            sys.stdout = console
    archive = shutil.make_archive(str(output_root), "zip", output_root)
    print("Completed. Archive:", archive, flush=True)


if __name__ == "__main__":
    main()
