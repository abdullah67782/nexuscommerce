"""Development run of the sequential inventory evaluation (mechanics, engine-parity sample, rehearsal of the gates).

Development products only (consumed + development_extra), replay 2015-05-03 .. 2015-10-31. Its outcomes are NOT
evidence and select nothing: the candidates are the frozen A2 selections and the gates are fixed in the protocol.

    python seq_dev.py --out DIR [--products N]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import seq_data as SD  # noqa: E402
import seq_core as SC  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--products", type=int, default=0)
    ap.add_argument("--parity-sample", type=int, default=3000)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    log = lambda m: print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)  # noqa: E731
    res_ = json.loads(SD.D.RESERVATION.read_text())
    products = sorted(res_["consumed_products"] + res_["development_extra_products"])
    if a.products:
        products = products[:a.products]
    SD.guard(products)
    table, excluded = SD.build_table(SD.D.m5_daily(products, SD.DEV_REPLAY[1]), SD.D.m5_launch_dates(products),
                                     SD.daily_prices(products, SD.DEV_REPLAY[1]), *SD.DEV_REPLAY)
    log(f"development series {len(table)}; excluded {excluded}")
    boosters, manifest = SC.C.production_boosters()
    rng = np.random.default_rng(2026)
    sample = []

    def record(idx, t, L, R, stock, T7, T28, arrivals, SS, q, ok):
        if len(sample) >= a.parity_sample:
            return
        pick = rng.choice(len(idx), size=min(6, len(idx)), replace=False)
        for j in pick:
            if not ok[j]:
                continue
            sample.append({"t": int(t), "L": int(L), "R": int(R), "on_hand": float(stock[j]), "t7": float(T7[j]), "t28": float(T28[j]),
                           "arrivals": {str(k + 1): float(arrivals[j, k]) for k in range(28) if arrivals[j, k] > 0},
                           "safety_stock": float(SS[j]), "quantity": float(q[j])})

    prep, res, meta = SC.run(table, SD.DEV_REPLAY[0], boosters, log, seed=7, record=record)
    (out / "engine_parity_sample.jsonl").write_text("\n".join(json.dumps(s) for s in sample) + "\n")
    g = SC.gates(prep, res, seed=11, parity_ok=None)
    report = {"label": "DEVELOPMENT rehearsal: not evidence", "replay": list(SD.DEV_REPLAY), "series": len(table), "excluded": excluded,
              "release": manifest.get("release"), **meta, "baselines": SC.baselines(prep, res), "cells": g}
    (out / "dev_results.json").write_text(json.dumps(report, indent=1, default=float) + "\n")
    for name, c in g.items():
        if "gates" in c:
            log(f"{name}: series {c['series']}, reduction {c['reduction_units']:.0f} units, net {c['net_benefit_primary']:.0f}, gates {c['gates']}")
        else:
            log(f"{name}: {c.get('reason')}")


if __name__ == "__main__":
    main()
