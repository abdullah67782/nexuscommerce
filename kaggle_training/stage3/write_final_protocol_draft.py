"""Writes outputs/final_protocol_draft.json (DRAFT for review; not frozen, nothing executed).
It records the selections from development, the calibration plan and the exact final windows, with hashes of
every development artefact it depends on. Freezing happens only after architect approval."""
import json
from pathlib import Path

import data_access as D

OUT = D.STAGE3 / "outputs"


def h(p):
    return D.sha256(p)


def main():
    unc = json.loads((OUT / "us" / "uncertainty_selection.json").read_text())
    dec = json.loads((OUT / "us" / "decision_selection.json").read_text())["selection"]
    draft = {
        "protocol_id": "nexus-stage3-final-protocol-v1 (DRAFT)",
        "status": "draft for review; not frozen; no reserved outcome accessed",
        "production_unchanged": ["nexus-v2-shared-20261008 models and hashes", "routing rule", "replenishment-1"],
        "depends_on": {
            "dev_protocol.json": h(OUT / "dev_protocol.json"),
            "dev_protocol_amendment_A1.json": h(OUT / "dev_protocol_amendment_A1.json"),
            "reservation_m5.json": h(OUT / "reservation_m5.json"),
            "data_access.py": h(D.STAGE3 / "data_access.py"),
            "served.py": h(D.STAGE3 / "served.py"),
            "events.py": h(D.STAGE3 / "events.py"),
            "us/uncertainty_selection.json": h(OUT / "us" / "uncertainty_selection.json"),
            "us/decision_selection.json": h(OUT / "us" / "decision_selection.json"),
            "pk/pk_results.json": h(OUT / "pk" / "pk_results.json"),
            "ml/models_v2/manifest.json": h(D.ROOT / "ml" / "models_v2" / "manifest.json"),
        },
        "us": {
            "products": "reservation nexus-stage3-m5-v1 holdout (90 products) x 10 stores, launch = first price week",
            "base": "frozen release nexus-v2-shared-20261008 served exactly (ml/v2 rule + TSB + 28-day average); parity on 300 sampled forecasts < 1e-3 units",
            "final_windows": {"within": ["2015-11-01", "2016-05-22"], "origins": "every 7 days from 2015-11-01", "horizons": [7, 28]},
            "calibration": {
                "data": "frozen-release forecasts on development products (consumed 180 + development_extra 150) x 10 stores",
                "windows_within": ["2015-06-01", "2015-10-31"], "origins": "every 7 days from 2015-06-01",
                "computed": ["U0 ratio quantiles per segment x horizon x level", "U1 score quantiles", "U2 conformal corrections (U2 boosters = development boosters, hashed at freeze)",
                             "D1 r_p (28-day U0 ratio quantile)"],
                "not_calibrated": ["U3 (own history)", "D2/D2c (own analogue paths; pooled by category x segment x origin from final products' own past)", "E1c (rule)"],
                "order": "calibration computed and hashed BEFORE the final outcomes are read",
            },
            "candidates": {
                "event": {"E1c": "25 December closure: F x (h - closed days in window)/h; no parameters", "E1_learned": "not carried (failed development)"},
                "totals_uncertainty": {k: v.get("method") for k, v in unc.items()},
                "decision_protection_frozen_rule": {k: v.get("method") for k, v in dec.items()},
                "decision_protection_kappa_robust_alternative": {
                    "regular|0.8": None, "regular|0.9": "D2c@0.9", "occasional|0.8": "D2c@0.8", "occasional|0.9": "D2c@0.9",
                    "rare|0.8": "D2c@0.8", "rare|0.9": "D2c@0.9", "short_history|0.8": "D2c@0.8", "short_history|0.9": "D2c@0.9",
                    "dormant|0.8": None, "dormant|0.9": None},
                "decision_selection_to_use": "PENDING architect decision D2",
            },
            "decision_track": {"pairs": [[3, 7], [7, 7], [3, 14], [7, 14], [14, 7]], "excluded": "L14/R14 (29 days > 28)",
                               "kappa": "1.0 all pairs; 0.5 and 1.5 on (7,7)", "scenarios": ["none", "mid"], "paths": 100,
                               "success": "no shortage in window a..a+R-1 (a = L+2) on actual daily demand",
                               "reported": ["lost units (lower bound)", "end stock", "shortage before arrival", "mean Q vs D0"]},
        },
        "pakistan": {
            "series": "15 named categories (primary); uncategorised reported separately; recorded order quantities",
            "base": "frozen release served exactly",
            "final_windows": {"within": ["2018-01-01", "2018-08-28"], "origins": "every 7 days from 2018-01-01", "horizons": [7, 28]},
            "calibration": {"U0_U1_windows_within": ["2017-07-01", "2017-12-31"]},
            "event_layer": {"fit_windows_within": ["2016-07-29", "2017-12-31"], "events": ["Independence Day", "Eid al-Adha"],
                            "alpha": 10, "label": "events with >= 2 fit occurrences only; others unadjusted (PENDING decision D3)"},
            "event_dates": "confirmed from official notifications and recorded before the run",
            "uncertainty": "U0/U1 coverage reported descriptively; no suggestion unless the frozen criterion passes",
        },
        "criteria": {
            "event": "event-window WAPE >= 5% better at both horizons; non-event and overall WAPE <= +0.5 points; |event bias| not larger; date-block and cluster 95% intervals of the improvement exclude 0; >= 2 fit occurrences per event",
            "totals_uncertainty": "coverage within +/-5 points (+/-10 rare) in event AND non-event windows; >= 200 windows and >= 30 series",
            "decision_protection": "coverage within +/-5 (+/-10 rare) on every pair and scenario at kappa 1 [plus kappa 0.5/1.5 on (7,7) if decision D2 adopts the robust rule]",
            "scope": "a pass authorises a suggestion only for the evaluated market, segment, horizon and level",
        },
        "statistics": {"date_block_bootstrap": "4-week blocks over origin dates, B=500", "cluster_bootstrap": "products (US) / categories (Pakistan)",
                       "occurrences": "counted per event; overlapping windows of one occurrence are one occurrence"},
        "execution": "one runner script, hashed at freeze; refuses a second run (lock file) or any hash mismatch; every outcome reported",
    }
    (OUT / "final_protocol_draft.json").write_text(json.dumps(draft, indent=2) + "\n")
    print("written", h(OUT / "final_protocol_draft.json"))


if __name__ == "__main__":
    main()
