"""Freeze the Stage 3 DEVELOPMENT protocol (architect review 2026-10-13). Run once.

Writes outputs/dev_protocol.json and outputs/dev_protocol.sha256. Everything that the
development experiments may choose is listed here BEFORE they read any data; results
cannot change these rules. Final-evaluation outcomes stay sealed: the final protocol is
written later, after development review, and frozen separately.
"""
import json
from datetime import datetime, timezone

import data_access as D

PRIMARY_US = ["Christmas", "NewYear", "Thanksgiving", "Easter", "IndependenceDay", "MemorialDay", "LaborDay",
              "Eid al-Fitr", "EidAlAdha", "Ramadan starts"]

PROTOCOL = {
    "protocol_id": "nexus-stage3-dev-protocol-v1",
    "scope": "Development experiments only. No final holdout outcome is read. Production models, routing and "
             "replenishment-1 are not changed.",
    "production_unchanged": {"ml/models_v2/shared_total_7.json": None, "ml/models_v2/shared_total_28.json": None},
    "data_access": {"module": "kaggle_training/stage3/data_access.py", "module_sha256": None,
                    "m5_development_end": "2015-05-31",
                    "m5_note": "Development experiments read M5 only to 2015-05-31. 2015-06-01..2015-10-31 is left for the "
                               "final protocol's calibration period; 2015-11-01..2016-05-22 is the final period.",
                    "pakistan_development_end": "2017-12-31",
                    "reservation": "outputs/reservation_m5.json", "reservation_sha256": None},
    "us_m5": {
        "series": "consumed (180) + development_extra (150) products x 10 stores; each series starts at its first "
                  "price week (launch proxy); reserved holdout products are refused by the loader",
        "base_forecast": "as served: v2 rule (rare -> TSB, otherwise shared model) for >= 180 days of history, "
                         "28-day average for 28-179 days, none below 28 — computed with research model copies",
        "research_copies": {
            "recipe": "production RECIPE and training code path (weekly_forecasting.direct_training_frame), 53 v2 "
                      "development products, eligible if first price <= cutoff - 180 days in all 10 stores",
            "R12": "2012-05-31", "R13": "2013-05-31", "R14": "2014-05-31",
            "rule": "every training target window ends on or before the cutoff; models saved outside ml/models_v2",
            "parity": "300 sampled forecasts recomputed with ml/v2 forecast_totals using the copy's boosters; "
                      "max difference must be < 1e-3 units"},
        "periods": {
            "FIT_A": {"model": "R12", "windows_within": ["2012-06-01", "2013-05-31"], "origins": "daily",
                      "use": "fit event-layer effects; train U2 quantile models"},
            "FIT_B": {"model": "R13", "windows_within": ["2013-06-01", "2014-05-31"], "origins": "daily",
                      "use": "fit event-layer effects; train U2 quantile models"},
            "CAL": {"model": "R14", "windows_within": ["2014-06-01", "2014-10-31"], "origins": "every 7 days",
                    "use": "calibrate U0, U1, U2 conformal correction; analogue pools for P1"},
            "SEL": {"model": "R14", "windows_within": ["2014-11-01", "2015-05-31"], "origins": "every 7 days",
                    "use": "compare candidates and select; nothing is fitted on SEL"}},
        "window_membership": "a forecast window [origin, origin+h-1] belongs to a period only if entirely inside it",
        "events": {"source": "M5 calendar (30 event names), known in advance at every origin",
                   "buckets": {"pre2": [-14, -8], "pre1": [-7, -1], "d0": [0, 0], "post1": [1, 3], "post2": [4, 7]},
                   "feature": "days of the forecast window in each (event, bucket) / horizon",
                   "primary_events_for_metrics": PRIMARY_US,
                   "event_window": "window overlaps [d-7, d+3] of any primary event; otherwise non-event"},
    },
    "pakistan": {
        "series": "15 named categories (primary) + uncategorised group reported separately; daily recorded order "
                  "quantities (not verified fulfilled demand: no order status)",
        "base_forecast": "frozen production release nexus-v2-shared-20261008 as served through ml/v2 (never trained or "
                         "evaluated on Pakistani data, so its 2016-17 errors are out-of-sample)",
        "periods": {"FIT": {"windows_within": ["2016-07-29", "2017-06-30"], "origins": "daily"},
                    "CAL": {"windows_within": ["2017-01-01", "2017-06-30"], "origins": "every 7 days"},
                    "SEL": {"windows_within": ["2017-07-01", "2017-12-31"], "origins": "every 7 days"}},
        "events": {"dates": "approximate (moon sighting); lunar events use the expected date +/-1 day spread evenly "
                            "unless the origin is on or after the day before the event",
                   "scope_of_claims": "category level, this marketplace only; no SKU advice, no general Pakistan-store "
                                      "effect; single occurrences in development are exploratory"},
        "event_layer": "every event occurs once in FIT, so the >= 2 occurrence requirement cannot be met in development: "
                       "E1 is fitted on single occurrences as an EXPLORATORY check, labelled as such, and would not be "
                       "used. The final protocol's fit period (to 2017-12-31) gives a second occurrence for some events.",
        "uncertainty": "U0 and U1 only (16 series are too few to train U2)",
        "decision_track": "not run: a category aggregate is not an inventory unit",
    },
    "event_layer_E1": {
        "form": "adjusted = F x exp(sum_k beta_k x_k); no intercept, so windows with no event exposure return F exactly",
        "fit": "Poisson deviance with exposure F (aggregated by origin date x horizon x level cell), ridge penalty",
        "zero_forecasts": "windows with F < 1.0 unit are excluded from fitting and never adjusted (labelled)",
        "overlapping_events": "effects add in log space; windows with more than one event are counted and reported",
        "occurrence_requirement": "an (event, bucket) effect is used only if its event has >= 2 occurrences in the fit "
                                  "data; otherwise the label is 'none' for that event",
        "candidates": {"levels": ["pooled", "pooled+category", "pooled+category+store"], "alpha": [0.1, 1.0, 10.0],
                       "group_feature_scale": 0.5},
        "selection": "on SEL: highest mean relative improvement in event-window WAPE over both horizons; ties -> "
                     "simpler level, then larger alpha"},
    "uncertainty_totals": {
        "levels": [0.8, 0.9],
        "coverage_definition": "share of evaluated windows in which actual total <= the method's p-quantile (one-sided "
                               "upper bound)",
        "segments": ["regular", "occasional", "rare", "dormant", "short_history (28-179 days)"],
        "candidates": {"U0": "empirical quantile of (A+1)/(F+1) per segment x horizon from CAL",
                       "U1": "split conformal on (A-F)/sqrt(F+1) per segment x horizon from CAL, finite-sample quantile",
                       "U2": "XGBoost quantile regression (v2 features + log1p(F)) trained on FIT_A+FIT_B, conformal "
                             "correction per segment x horizon on CAL",
                       "U3": "rare segment only: TSB bootstrap (Bernoulli occurrence x empirical nonzero sizes from the "
                             "last 180 days), 400 draws"},
        "selection": "per segment x horizon x level on SEL: candidates whose coverage is within +/-5 points of p "
                     "(+/-10 for rare) in BOTH event and non-event windows; choose the smallest mean (upper-F)/(F+1); "
                     "none passing -> no suggestion for that segment"},
    "decision_track_us": {
        "logic": "Stage 2 engine minimum quantity: order usable on day a = L+2; window a..a+R-1; Q = smallest quantity "
                 "with no shortage on every day of the window; whole units; MOQ = pack = 1; no other incoming",
        "planning_pairs": [[3, 7], [7, 7], [3, 14], [7, 14], [14, 7]],
        "excluded": "L=14, R=14 needs 29 days (> 28-day forecast); not evaluated in this track",
        "starting_stock": "S0 = round(kappa x point demand over days 1..L+1); kappa = 1.0 (sensitivity 0.5 and 1.5)",
        "outcome": "SUCCESS = no shortage on any day of the window a..a+R-1 when Q is added on day a and actual daily "
                   "demand is applied (lost sales before a). Shortage before arrival is reported separately.",
        "coverage_definition": "share of decisions with SUCCESS",
        "methods": {"D0": "Q from the point path (A1 spreading of R14 totals), safety stock 0 (replenishment-1 today)",
                    "D1": "D0 plus safety stock = (r_p - 1) x point window demand, r_p = U0 28-day ratio quantile "
                          "(the totals-quantile approach the review questioned)",
                    "D2": "P1 paths: Q_p = ceil(p-quantile over 100 paths of minQ(path))",
                    "D2e": "D2 with the selected E1 daily multipliers (only if an E1 candidate is selected)"},
        "P1_paths": "analogue bootstrap: own past 28-day windows starting origin-7k, k=4..52, each divided by its "
                    "preceding 28-day mean + 1, scaled so the mean analogue total equals the point 28-day forecast; "
                    "fewer than 6 own analogues -> pooled windows from series of the same category and segment",
        "selection": "per segment x level: methods with coverage within +/-5 points (+/-10 rare) -> lowest mean Q; "
                     "none -> no suggestion"},
    "statistics": {
        "intervals": "95% percentile intervals from a block bootstrap over origin dates (4-week blocks; all series "
                     "sharing a date move together), B = 500; event improvements also with a product-cluster bootstrap",
        "occurrences": "each event's occurrences per period are counted and reported; overlapping windows around one "
                       "occurrence are not counted as separate occurrences",
        "small_samples": "segments with < 30 series or < 200 windows are reported as insufficient"},
    "stockouts": "no censoring in development (no availability records). Heuristic flags only: regular series with >= 3 "
                 "consecutive zero days outside Christmas; results also shown excluding flagged windows",
    "reporting": "every candidate, segment and failure is reported; development results are not final evidence",
}


def main():
    out = D.STAGE3 / "outputs" / "dev_protocol.json"
    if out.exists():
        raise SystemExit("Development protocol already frozen.")
    PROTOCOL["data_access"]["module_sha256"] = D.sha256(D.STAGE3 / "data_access.py")
    PROTOCOL["data_access"]["reservation_sha256"] = D.sha256(D.RESERVATION)
    for path in PROTOCOL["production_unchanged"]:
        PROTOCOL["production_unchanged"][path] = D.sha256(D.ROOT / path)
    PROTOCOL["frozen_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out.write_text(json.dumps(PROTOCOL, indent=2) + "\n")
    (D.STAGE3 / "outputs" / "dev_protocol.sha256").write_text(D.sha256(out) + "\n")
    print("frozen", D.sha256(out))


if __name__ == "__main__":
    main()
