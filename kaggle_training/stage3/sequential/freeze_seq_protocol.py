"""Write (and, with --freeze, freeze) the sequential protocol nexus-stage3-seq-protocol-v1.

A frozen protocol is never overwritten. A draft may be rewritten until it is frozen.
    python freeze_seq_protocol.py [--freeze]
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import seq_protocol_spec as SPEC  # noqa: E402
import replay as RP  # noqa: E402
import evaluate as EV  # noqa: E402
import seq_core as SC  # noqa: E402
import seq_data as SD  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true")
    a = ap.parse_args()
    if SPEC.PROTOCOL.exists() and json.loads(SPEC.PROTOCOL.read_text()).get("status") == "frozen":
        raise SystemExit("the sequential protocol is frozen; it is never rewritten")
    v1 = json.loads((SPEC.OUT / "final_protocol.json").read_text())
    protocol = {
        "protocol_id": SPEC.PROTOCOL_ID,
        "status": "frozen" if a.freeze else "draft",
        "written_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "purpose": "Does ordering with the frozen AI purchasing-protection selections, repeated over many review cycles, reduce lost "
                   "sales enough to pay for the extra stock it holds, and does it beat the seller's own safety stock?",
        "governance": {
            "amendment_F1": "decision protection stays research-only; no result here authorises promotion (promotion_authorised false)",
            "pass_means": "an implementation review of OPTIONAL, seller-approved advice for that segment and level only",
            "clearance": ("owner's direct instruction of 2026-10-14 to finish the module (the architect's clearance was still pending; "
                          "the owner's instruction takes precedence). The development rehearsal selected nothing and changed no gate.")
                         if a.freeze else "pending",
            "no_new_candidates": "the candidates are the frozen A2 selections of protocol v1 (sha "
                                 f"{SPEC.sha_file(SPEC.OUT / 'final_protocol.json')}); nothing is selected or tuned here",
        },
        "base_release": v1["base_release"],
        "candidates": {k: {"segment": s, "level": p, "method": ("D2c" if c else "D2") + f"@{p}"} for k, (s, p, c) in SC.frozen_cells().items()},
        "comparators": {"D0": "Stage 2 quantity on the point forecast (A1), safety stock 0",
                        "seller_rule": f"Stage 2 quantity with a seller-set safety stock of k days of average daily sales over the 28 days before "
                                       f"the replay, fixed at the start, k in {list(RP.SELLER_DAYS)}"},
        "replay": {
            "development": list(SD.DEV_REPLAY), "final": ["2015-11-23", "2016-05-22"], "days": RP.REPLAY_DAYS,
            "pairs_L_R": RP.PAIRS, "kappas": list(RP.KAPPAS), "primary_kappa": 1.0, "review_forecasts": "frozen release served at every review day on history up to that day",
            "order_usable": "day t + L + 1 (A2)", "lost_sales": "unmet demand is lost (A3); a lower bound where stock-outs are unknown",
            "starting_stock": "kappa x forecast for the first L + 1 + R days (A1; T28/28 rate when T28 < T7), rounded",
            "inconsistent_forecast": "T28 < T7: no policy orders at that review (the engine gives no quantity)",
            "paths": f"{RP.J_PATHS} analogue paths per series and review (own windows; pooled by category and segment below 6); "
                     "D2c zeroes 25 December; seeded per series and review",
            "cell_rule": "a cell's method is used at a review only when the product is in the cell's segment then; otherwise D0. "
                         "The cell is evaluated on the series in its segment at the start of the replay.",
            "pack_and_moq": "1 and 1", "ordering_cost": "not modelled (no data)", "unit_value": "M5 weekly sell price (cost is not in the data)",
        },
        "data": {
            "development": "consumed 180 + development_extra 150 products x 10 stores, guarded loaders, days <= 2015-10-31",
            "final": "reservation nexus-stage3-seq-m5-v1: 150 never-read products x 10 stores (outputs/reservation_seq_m5.json)",
            "excluded": "series with fewer than 28 days of history at the replay start (reported, never replaced)",
        },
        "assumptions": {"primary": {"margin": EV.MARGIN, "annual_holding_rate": EV.HOLD},
                        "sensitivity": {"margin": list(EV.GRID_M), "annual_holding_rate": list(EV.GRID_H)},
                        "decides": "only the primary pair"},
        "gates": {
            "G1": f">= {EV.MIN_SERIES} series and >= {EV.MIN_REPLAYS} series x pair replays in the cell",
            "G2": "lost units below D0, pooled over the five pairs at kappa 1; product-cluster and 28-day date-block 95% bootstrap "
                  f"intervals (B = {EV.B}) of the reduction both above 0",
            "G3": "net benefit = margin x value of avoided lost sales - holding rate / 365 x extra stock value-days > 0 at the primary "
                  "assumptions; both 95% intervals above 0",
            "G4": "at the candidate's stock-holding value the seller-rule curve S(0..14 days) (linear interpolation) loses at least as "
                  "much sales value; a candidate holding more than S(14) fails",
            "G5": "at kappa 0.5 and 1.5 the reduction and the primary net benefit stay above 0",
            "G6": ">= 2000 sampled final-run decisions (D0 and a seller rule) recomputed by backend/lib/replenishment/engine.js equal the "
                  "replay exactly",
            "all": "a cell passes only if G1–G6 all hold",
        },
        "seeds": {"replay": 7, "gates": 11, "parity_sample": 2026},
        "environment": {"python": "3.12", "numpy": "1.26.4", "pandas": "2.2.2", "scipy": "1.17.1", "xgboost": "3.4.1", "node": "required"},
        "execution": {"entry": "kaggle_training/stage3/sequential/seq_final.py",
                      "preflight": "python seq_final.py preflight --out <empty dir>",
                      "final": "python seq_final.py execute-once --confirm <sha256(seq_protocol.json)> --lock-dir <persistent dir> --out <empty dir>",
                      "rerun_protection": "hash checks; preflight; O_CREAT|O_EXCL lock; non-empty output refused; aborted runs keep the lock"},
        "development_reference": {"dev_results_sha256": SPEC.sha_file(SPEC.OUT / "sequential_dev" / "dev_results.json")
                                  if (SPEC.OUT / "sequential_dev" / "dev_results.json").exists() else None,
                                  "note": "development rehearsal (cloud, not evidence)"},
        "hashes": SPEC.hashes(),
    }
    SPEC.PROTOCOL.write_text(json.dumps(protocol, indent=2) + "\n")
    print(protocol["status"], SPEC.sha_file(SPEC.PROTOCOL), len(protocol["hashes"]), "files")


if __name__ == "__main__":
    main()
