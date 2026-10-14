# Inventory AI — Stage 3 development report (development data only)

Status: **for architect review, before any reserved final outcome is accessed.**

- Everything here uses development data only: M5 to 2015-05-31 for development products, and the Pakistan extract to 2017-12-31.
- The reserved M5 products, the M5 final calibration and final periods, and Pakistan 2018 were **not accessed**. The loaders refuse them (§1.2).
- Production is unchanged: `nexus-v2-shared-20261008` (model hashes unchanged), its routing rule and `replenishment-1`. Manual training stays disabled. No model was written to `ml/models_v2`.
- These are development results. They are not final evidence and support no accuracy or "confidence" claim.

## 0. Post-review corrections (2026-10-13; the sections below are kept as originally submitted)

- **Exact thresholds.** §6.3 read rounded coverages. Checked exactly (integer arithmetic, `final/exact_recheck.py`):
  - The original selections in §5, §6 and §9 are all confirmed.
  - The κ-robust alternative was misstated. For regular 90%, D2c@0.9 reaches 0.848 at κ = 1.5, below 0.85, so A2 selects **D2@0.9**. For occasional 80%, D2c@0.8 reaches 0.852 at κ = 0.5, above 0.85, so A2 makes **no suggestion**.
  - Frozen A2 selections: regular 80% none, regular 90% D2@0.9, occasional 80% none, occasional 90% D2c@0.9, rare D2c@0.8/0.9, short history D2c@0.8/0.9, dormant none.
- **Decision-specific quantities.** The §6.4 statement "safety stock = Q_method − Q_D0" is withdrawn. Stage 2's daily checkpoints do not make an SS setting equal to Q_D0 + SS. Methods are judged on each decision's own quantity.
- **Shortage/excess gate.** The gate and the frozen caps are in `docs/inventory-stage3-final-protocol.md` §2.2.
- **Decisions applied.** D1–D4 are applied. The final protocol is frozen as `nexus-stage3-final-protocol-v1` (sha `8c385172…`).

Contents:
1. Corrections made, and the audit trail
2. Frozen development protocol, amendment and hashes
3. Research model copies and parity
4. US results: event layer E1
5. US results: uncertainty of 7- and 28-day totals
6. US results: protection measured on the inventory decision
7. Pakistan results (category level, this marketplace only)
8. Stockout flag sensitivity
9. Selected candidates
10. Calibration plan for the final evaluation
11. Exact final-evaluation protocol (draft; not executed)
12. Limitations and scope
13. Decisions requested

---

## 1. Corrections made, and the audit trail

| Codex correction | What was done | Where |
|---|---|---|
| 1. Audit wording | The original audit script and output are **preserved unchanged** (`audit_datasets.py` sha `bc24e21a…`, `audit.json` sha `e34ee9ab…`). The correction note records that the audit **loaded the full M5 sales file, all Pakistan rows and Store Item 2017 into memory, and excluded them from analysis**. No excluded target was aggregated. It also fixes the category count: 15 named categories plus an uncategorised group (`\N`, 295 products), 16 groups in all. | `stage3_audit/AUDIT_CORRECTION.md` |
| 1. Guarded loaders | `stage3/data_access.py` (sha `839405e7…`). <br>**M5:** reads only day columns up to the requested end and only requested product rows. It raises `FinalAccessSealed` for any end date after 2015-10-31 or any reserved product. <br>**Pakistan:** reads a development extract made on the owner's machine by a stdlib script that tests the date field first and drops later lines unread and uncounted. The extract has 424,809 rows and sha `fa96772c…`; the loader verifies the manifest and the maximum date ≤ 2017-12-31. | `stage3/data_access.py`, `extract_pakistan_dev.py` |
| 2. M5 chronology | Research copies R12, R13 and R14 were trained with the frozen recipe, each before the period it serves. Every training target window ends on or before its cutoff (asserted). Fitting (FIT_A/FIT_B), calibration (CAL) and selection (SEL) periods are disjoint. The frozen release stays the comparator for the final evaluation. | §3 |
| 3. Protection on the decision | For each sampled daily path, the order quantity is computed with Stage 2's daily-checkpoint logic. Success means no shortage in the review window after the order is usable. Shortage before arrival is reported separately. L=14/R=14 is excluded (29 days > 28). | §6 |
| 4. Evidence boundaries | Pakistan results are category-level and marketplace-only. The target is recorded order quantities. Eid wording corrected. Occurrence counts are reported. Date-block (4-week) and product-cluster bootstraps are used. Selection used development data only. | §4–§7 |
| 5. Stockouts | No censoring. A heuristic flag only (regular series, ≥3 consecutive zeros outside 25 December), reported as a sensitivity. No real-world claims from simulations. | §8 |

## 2. Frozen development protocol, amendment and hashes

| Item | Identifier / sha256 |
|---|---|
| M5 reservation | `nexus-stage3-m5-v1`, seed 2514759579. 90 holdout products (30 per category) and 150 development-extra products, drawn from the catalog only. `reservation_m5.json` sha `ba8f1a1b…`. |
| Development protocol | `nexus-stage3-dev-protocol-v1`, sha `5b4b618c3fb3326531f64a12bd0ca5a996937fbafe89a4ad4f2932473ec4569c` |
| Amendment A1 | `dev_protocol_amendment_A1.json`, sha `916c0b11…`. Frozen before running and **disclosed as a second look at SEL** (§4.2). |
| Research model index | `research_models/index.json`, sha `972d6ee8…` |

## 3. Research model copies and parity

| Copy | Cutoff | Eligible v2 products | Series | Serves |
|---|---|---|---|---|
| R12 | 2012-05-31 | 20 | 200 | FIT_A: windows 2012-06-01..2013-05-31, daily origins |
| R13 | 2013-05-31 | 29 | 290 | FIT_B: 2013-06-01..2014-05-31, daily origins |
| R14 | 2014-05-31 | 46 | 460 | CAL: 2014-06-01..2014-10-31 and SEL: 2014-11-01..2015-05-31, every 7 days |

- The early copies have fewer products, because a product is eligible only once it has been priced for 180 days before the cutoff. They are weaker than production, and that is disclosed.
- **Development series:** 180 consumed products plus 150 development-extra products, × 10 stores. That gives 3,284 series after launch eligibility.

**Parity.** Forecasts were served exactly as the app serves them (the as-served rule). The maximum differences against `ml/v2/forecast_totals` were 1.5e-5, 1.4e-5, 2.0e-5 and 7e-6 units for FIT_A, FIT_B, CAL and SEL.

**Finding worth recording.** The pandas training-feature code differs from the app's numpy `origin_features` by about 4e-7. That is enough to cross a tree split and move a forecast by up to 0.65 units. The production check compared features only (2.2e-7) and never compared predictions, so it would not have caught this. The research code now uses the app's own feature code.

## 4. US results: event layer E1

### 4.1 Frozen candidates (fit on FIT_A+FIT_B, compared on SEL)

**Base R14 forecast (WAPE):**

| Horizon | Event windows | Non-event windows |
|---|---|---|
| 7 days | 40.96% | 40.57% |
| 28 days | 32.96% | 32.93% |

**SEL coverage:**

| Horizon | Windows | Event windows |
|---|---|---|
| 7 days | 96,881 | 35,411 |
| 28 days | 87,065 | 54,714 |

- About 3,273 series appear in SEL.
- **Primary occurrences in SEL, one each:** Thanksgiving 2014, Christmas 2014, New Year 2015, Easter 2015 and Memorial Day 2015. Windows that overlap more than one event: 27 (7-day) and 30 (28-day).
- 31,991 rows had F < 1 and were left unadjusted.

**All 9 candidates scored below zero, from −0.0004 to −0.0165.** That covers 3 levels × α ∈ {0.1, 1, 10}. The best was pooled+category+store, α=10, at −0.0004. **E1 does not improve event windows in US development data.**

### 4.2 Amendment A1 (second look, disclosed)

**Diagnosis, from fit data only.** The penalty normalisation over-shrank rare one-day effects. For example, it estimated Christmas d0 at ×0.86, although the stores are closed (0 and 4 units on 25 December across about 2,400–2,800 series).

**Candidates:**

| Candidate | What it does | Score |
|---|---|---|
| E1w | Exposure-weighted penalty | −0.0106 to −0.0155 |
| E1cw | E1w combined with the closure rule | −0.0106 to −0.0155 |
| **E1c** | Deterministic closure rule: F × (h − closed days)/h for 25 December | **+0.00174** |

**E1c in detail:**
- **7 days:** +0.27% relative improvement in event-window WAPE. Date-block 95% interval [0, 0.68%]; product-cluster interval [−0.06%, 0.62%].
- **28 days:** +0.07%.
- **Per event, 7-day WAPE:** Christmas 42.61 → 42.18; New Year 43.51 → 43.08. Thanksgiving, Easter and Memorial Day are unchanged.

**Conclusion: E1 fails the ≥5% gate in US development.** The only thing that helps is the closure rule, and only marginally. A learned event layer for US-like stores is **not** recommended for the final evaluation (§13, D1).

## 5. US results: uncertainty of 7- and 28-day totals

Coverage is the share of SEL windows with actual ≤ the upper quantile (one-sided). The frozen selection rule:
1. Keep candidates within ±5 points of target (±10 for rare) in **both** event and non-event windows, with at least 200 windows and 30 series.
2. Choose the smallest mean relative width.
3. If none qualifies, make no suggestion.

Calibration is on CAL; nothing is fitted on SEL.

**Selected method and coverage** (each cell is method, overall coverage, then [event / non-event]):

| Segment | 7 days, 80% | 7 days, 90% | 28 days, 80% | 28 days, 90% |
|---|---|---|---|---|
| Regular (≈430 series) | U0 0.792 [0.787 / 0.795] | U0 0.896 [0.894 / 0.897] | U0 0.803 [0.803 / 0.804] | U0 0.899 [0.897 / 0.902] |
| Occasional (≈2,200) | U2 0.801 [0.811 / 0.795] | U0 0.899 [0.903 / 0.896] | U0 0.802 | U0 0.899 |
| Rare (≈1,380) | U3 0.810 | U3 0.871 | U0 0.781 [0.797 / 0.756] | U1 0.883 [0.897 / 0.862] |
| Dormant (160) | none | none | none | U2 0.898 [0.922 / 0.857] |
| Short history (≈257) | U2 0.801 | U2 0.906 | U0 0.820 | U1 0.899 |

**Date-block 95% intervals:**

| Cell | Interval |
|---|---|
| Regular, 7 days, 90% | [0.887, 0.904] |
| Occasional, 28 days, 90% | [0.894, 0.907] |
| Rare, 7 days, 90% | [0.864, 0.877] |
| Short history, 28 days, 90% | [0.851, 0.934] |

The rest are in `outputs/us/uncertainty_selection.json`.

**Mean relative width** ((upper − F)/(F+1)):

| Segment | 80% | 90% |
|---|---|---|
| Regular, 7 days | 0.28 | 0.47 |
| Regular, 28 days | 0.25 | 0.41 |
| Occasional | 0.32–0.36 | 0.58–0.68 |

**Notes:**
- U0, the simplest method, was selected in 9 of 17 selected cells.
- **Dormant:** every candidate over-covers at 7 days and at 28 days/80%, so those cells get no suggestion.
- **Rare, 7 days, 90%:** U3 sits at 0.871, inside the ±10 tolerance for rare, but below target.

## 6. US results: protection measured on the inventory decision

### 6.1 Set-up (frozen before running; scenario and κ settings disclosed in the script docstring)

**Decision sample:**
- **Origins:** SEL every 7 days. The daily window lies inside SEL: 86,733 decisions.
- 332 decisions were skipped because T28 < T7 (an inconsistent pair of totals).
- **Pairs (L, R):** (3,7), (7,7), (3,14), (7,14), (14,7). L14/R14 is excluded (29 days).
- **Starting stock:** S0 = round(κ × point demand over days 1..L+1). κ=1 for every pair; κ ∈ {0.5, 1.5} as a sensitivity on (7,7).
- **Order usable:** day a = L+2. Stock at a−1 = max(0, S0 − actual demand over days 1..a−1), with lost sales.

**Incoming-order scenarios:**

| Scenario | What arrives during the window |
|---|---|
| `none` | Nothing |
| `mid` | An existing order usable at day a + R/2, sized to the point demand of the window's second half. Only the daily checkpoints can catch a gap before that delivery. |

**Methods** (quantity rounded up to whole units):

| Method | Order quantity |
|---|---|
| D0 | Stage 2 quantity on the point path (A1 spreading), with safety stock 0 |
| D1@p | max(D0, SS − projected end balance), where SS = (r_p − 1) × point window demand and r_p is the CAL 28-day U0 ratio quantile |
| D2@p | p-quantile, over 100 P1 analogue paths, of the Stage 2 minimum quantity for each path (P1 = own 28-day windows at i − 7k, k=4..52, normalised and scaled to T28; pooled by category × segment × origin when the series has fewer than 6 analogues: 909 decisions) |
| D2c@p | D2 with 25 December zeroed in each path (the E1c closure rule) |

**Outcomes:**
- **Success:** no shortage on any day of the window a..a+R−1, against actual daily demand, with the order added on day a.
- **Reported alongside:** lost units in the window, end stock, and shortage before arrival.

### 6.2 Results (κ = 1, both scenarios, all five pairs)

| Segment | D0 coverage | D1@0.8 | D2c@0.8 | D1@0.9 | D2c@0.9 | Mean Q: D0 → selected@0.9 | Lost units D0 → @0.9 | End stock D0 → @0.9 |
|---|---|---|---|---|---|---|---|---|
| Regular | 0.48–0.63 | **0.770–0.801** | 0.732–0.765 | **0.864–0.888** | 0.850–0.869 | 35.4 → 54.9 | 7.16 → 2.19 | 11.4 → 25.9 |
| Occasional | 0.62–0.74 | 0.817–0.843 | **0.820–0.850** | **0.890–0.903** | 0.892–0.916 | 8.07 → 14.07 | 2.20 → 0.89 | 4.0 → 8.7 |
| Rare | 0.70–0.83 | 0.840–0.896 | **0.796–0.863** | 0.890–0.929 | **0.847–0.907** | 1.80 → 4.06 | 0.67 → 0.40 | 1.4 → 3.4 |
| Short history | 0.62–0.75 | 0.844–0.881 | **0.788–0.837** | 0.904–0.928 | **0.853–0.892** | 5.23 → 10.56 | 1.31 → 0.59 | 2.6 → 7.2 |
| Dormant | 0.92–0.96 | over-covers | over-covers | over-covers | over-covers | — | — | — |

Bold marks the method chosen by the frozen rule. The rule: κ=1; within tolerance on every pair and both scenarios; at least 200 decisions; then the lowest mean Q.

**Shortage before arrival** (κ=1, mean units per decision): regular 6.74, occasional 2.13, rare 0.73, short history 1.36. An order placed today cannot fix this; it is reported separately, as required.

**Event versus non-event decision windows** (selected methods, κ=1; window overlaps a primary event's [d−7, d+3]):

| Segment | Level | Method | Event windows | Non-event windows |
|---|---|---|---|---|
| Regular | 80% | D1 | 0.783 | 0.792 |
| Regular | 90% | D1 | 0.871 | 0.881 |
| Occasional | 80% | D2c | 0.837 | 0.835 |
| Occasional | 90% | D1 | 0.902 | 0.895 |
| Rare | 80% | D2c | 0.844 | 0.828 |
| Rare | 90% | D2c | 0.890 | 0.877 |
| Short history | 80% | D2c | 0.822 | 0.811 |
| Short history | 90% | D2c | 0.883 | 0.869 |

**Date-block 95% intervals for the selected methods' coverage:**

| Segment | 80% | 90% |
|---|---|---|
| Regular | [0.771, 0.809] | [0.860, 0.893] |
| Occasional | [0.833, 0.840] | [0.894, 0.903] |
| Rare | [0.824, 0.844] | [0.870, 0.891] |
| Short history | [0.781, 0.850] | [0.842, 0.905] |

### 6.3 A robustness problem found: D1 depends on the starting stock

**κ sensitivity on (7,7)** (coverage for the `none` / `mid` scenarios):

| Segment, level | Method | κ = 0.5 | κ = 1.0 | κ = 1.5 |
|---|---|---|---|---|
| Regular, 80% | **D1** (selected) | 0.766 / 0.743 | 0.789 / 0.770 | **0.645 / 0.601** |
| Regular, 80% | D2c | 0.765 / 0.765 | 0.750 / 0.751 | 0.730 / 0.733 |
| Regular, 90% | **D1** (selected) | 0.854 / 0.847 | 0.870 / 0.864 | **0.742 / 0.712** |
| Regular, 90% | D2c | 0.865 / 0.867 | 0.860 / 0.861 | 0.848 / 0.851 |
| Occasional, 90% | **D1** (selected) | 0.890 / 0.882 | 0.899 / 0.892 | **0.833 / 0.812** |
| Occasional, 90% | D2c | 0.914 / 0.916 | 0.912 / 0.914 | 0.905 / 0.907 |
| Rare, short history | D2c (selected) | stable within ±0.01 across κ | | |

**Cause.** D1 protects only the variability of demand *within the review window*. When stock carried into the arrival day is large (κ=1.5), D1 counts the whole projected surplus as available. It does not protect against higher-than-expected demand *before* arrival eating that surplus. D2 simulates the whole path from today, so it is robust to κ.

**Consequence.** The frozen rule (κ=1 only) selected D1 for three cells (regular 80%, regular 90%, occasional 90%). D1 is not robust in a situation sellers will be in: holding above-forecast stock. I have **not** changed the selection, because doing so after seeing the results would be a post-hoc choice. §13 (D2) asks Codex to decide.

Under a κ-robust rule (within tolerance at every κ as well), the selections would be:
- **Regular 90%:** D2c@0.9 (0.848–0.869).
- **Occasional 90%:** D2c@0.9 (0.892–0.916).
- **Regular 80%:** no suggestion. D2c@0.8 reaches 0.730–0.765, below the 0.75 floor at some pairs.

### 6.4 What this does and does not show

- Lost units come from replaying recorded sales. Where stock-outs are unknown, observed sales understate demand, so **lost units are a lower bound and coverage is an upper bound**. No real-world claim is made.
- **The comparison that matters for the seller:** with safety stock 0 (today's `replenishment-1` default), the review window had no shortage in about 56% of regular decisions (0.48–0.63 by pair). A selected 90% method raises that to 0.85–0.89, at about 55% more units ordered and about 2.3× the end stock.
- How the suggestion would appear: as `safety stock = Q_method − Q_D0` units, entered by the seller. Never applied automatically.

## 7. Pakistan results (category level, this marketplace only)

**Data and scope:**
- **Series:** 15 named categories, as daily recorded order quantities. This is **not** verified fulfilled demand: there is no order status, so cancellations are included. The uncategorised group (`\N`) is reported separately.
- The base forecast is the **frozen production release**, served exactly. Parity: max 2.5e-4 units on category totals of hundreds to thousands of units.
- The release was never trained or evaluated on Pakistani data. This is its first out-of-country check (development only).
- **Windows (named categories):** FIT 4,965 (7-day) / 4,650 (28-day); CAL 375 / 330; SEL 390 / 345.

**Event occurrences** (approximate dates; lunar ±1 day):

| Period | Events, one occurrence each |
|---|---|
| FIT | Independence Day 2016, Eid al-Adha 2016, Black/White Friday 2016, Christmas/Quaid Day 2016, New Year 2017, Pakistan Day 2017, Ramadan start 2017, Eid al-Fitr 2017 |
| SEL | Independence Day 2017, Eid al-Adha 2017, Black/White Friday 2017, Christmas/Quaid Day 2017 |

Eid al-Fitr 2016 (6 July) is before the first FIT window, so it gives no exposure.

### 7.1 Frozen model on this marketplace (named categories)

| Period | 7-day WAPE (event / non-event) | 28-day WAPE (event / non-event) | 28-day bias |
|---|---|---|---|
| CAL 2017-01..06 | 53.6% (56.6 / 51.6) | 47.0% (50.0 / 40.6) | −29% |
| SEL 2017-07..12 | 78.4% (79.2 / 77.4) | 73.7% (80.6 / 45.5) | −40% |

- Category WAPE on SEL ranges from 32% (Soghaat) to 137% (Others).
- The large under-forecast at 28 days is concentrated in windows containing the November 2017 Black/White Friday campaign.
- **This is a single marketplace's recorded orders. It does not describe a Pakistani store.**

### 7.2 E1 — exploratory only (every effect from one occurrence)

| α | 7-day event-window change | 28-day event-window change | Non-event WAPE (7 / 28 days) |
|---|---|---|---|
| 0.1 | **−79%** (79.2 → 141.4) | +23% (80.6 → 62.2) | 77.4 → 75.1 / 45.5 → 44.9 |
| 1 | −63% | +23% | 73.1 / 44.9 |
| 10 | +0.2% | +18% | 72.0 / 45.2 |

- At low α, the 28-day gain comes mostly from the 2016 Black/White Friday effect. Fitted multipliers per exposed day reach ×21 in the week before.
- The same single-occurrence effects badly damage 7-day windows.
- **Wording.** Eid al-Fitr and Eid al-Adha 2016/17 multipliers range from 0.46 to 2.85 across buckets, each from one occurrence. That is *no consistent Eid pattern observed in this marketplace's development data*, and it is not evidence of an Eid effect, or of its absence, for stores.
- **Status: exploratory, not a candidate.** The ≥2-occurrence rule cannot be met in development.

### 7.3 Uncertainty (U0/U1, calibrated on CAL, evaluated on SEL; pooled named categories)

| Horizon, level | U0 coverage (event / non-event) | U1 coverage (event / non-event) |
|---|---|---|
| 7 days, 80% | 0.772 (0.704 / 0.808) | 0.777 (0.681 / 0.827) |
| 7 days, 90% | 0.869 (0.763 / 0.925) | 0.867 (0.763 / 0.922) |
| 28 days, 80% | 0.701 (0.693 / 0.717) | 0.728 (0.693 / 0.792) |
| 28 days, 90% | 0.786 (0.756 / 0.842) | 0.797 (0.760 / 0.867) |

**No cell meets ±5 points in both event and non-event windows, so there is no Pakistan suggestion.** Event-window coverage is low because the base model under-forecasts the campaign periods.

**Decision track:** not run. A category aggregate is not an inventory unit.

## 8. Stockout flag sensitivity (US)

**Flag:** a regular series with ≥3 consecutive zero days in the window, outside 25 December. No censoring is applied.

| Horizon | Regular SEL windows flagged |
|---|---|
| 7 days | 649 of 8,331 (7.8%) |
| 28 days | 1,715 of 7,539 (22.7%) |

**Coverage of the selected U0 when flagged windows are excluded:**

| Cell | All windows | Flagged windows excluded |
|---|---|---|
| 7 days, 80% | 0.792 | 0.779 |
| 7 days, 90% | 0.896 | 0.890 |
| 28 days, 80% | 0.803 | 0.779 |
| 28 days, 90% | 0.899 | 0.891 |

**Reading.** Flagged windows are easy to "cover" because they contain zeros. If those zeros are stock-outs, true coverage is slightly lower. The 28-day 80% cell would fall to 0.779, still inside ±5. M5 has no availability record, so this cannot be resolved; it is reported as uncertainty, not corrected.

## 9. Selected candidates (development)

| Capability | Frozen-rule selection | Recommendation for the final evaluation |
|---|---|---|
| Learned event layer E1, US | None passes (all scores < 0) | Not carried forward |
| Closure rule E1c, US | +0.27% (7-day event windows) | Carry as a deterministic rule tested against the same E1 gates. It is expected to fail the 5% gate; it is reported either way. (D1 in §13) |
| Totals uncertainty, US | Per segment × horizon × level, as in §5 (U0 ×9, U2 ×4, U3 ×2, U1 ×2 cells; dormant mostly none) | Freeze as listed |
| Decision protection, US | Regular: D1@0.8, D1@0.9. Occasional: D2c@0.8, D1@0.9. Rare: D2c@0.8, D2c@0.9. Short history: D2c@0.8, D2c@0.9. Dormant: none | **Codex decides** between the frozen rule and the κ-robust rule (§6.3; D2 in §13) |
| Pakistan E1 | Exploratory only | Final: evaluated only for events with ≥2 fit occurrences by 2017-12-31 (Independence Day, Eid al-Adha), α=10, labelled. (D3 in §13) |
| Pakistan uncertainty | None | Reported descriptively in the final run; no suggestion unless the frozen criterion passes |
| 95% target | Not offered | Not offered (Q8) |

## 10. Calibration plan for the final evaluation

No calibration uses final-period outcomes. Every calibrated quantity is computed once, frozen with hashes, and only then are the final outcomes read.

**US** (base = frozen release `nexus-v2-shared-20261008`, served exactly):

| Quantity | Calibration data |
|---|---|
| U0 ratio quantiles; U1 score quantiles; U2 conformal corrections; D1 `r_p` | Frozen-release forecasts on **development products** (330 × 10 stores), windows entirely inside **2015-06-01..2015-10-31**, every 7 days. Per segment × horizon, finite-sample quantile. The frozen release was trained to 2015-05-31, so these windows are out-of-sample in time. |
| U2 quantile boosters | The development boosters (trained on FIT_A+FIT_B rows). Only the conformal correction is recomputed. They were trained in memory, so at freeze they are re-trained with the identical deterministic settings (seed 42), saved outside `ml/models_v2`, checked to reproduce the development SEL coverage, and hashed. |
| U3, D2/D2c | No fitted parameters. They use each series' own history before the origin (and pooled analogues by category × segment × origin from the final products' own past). |
| E1c | No parameters (25 December closure). |

- The guarded loader allows 2015-06..10 for development products only. That data is not yet read.

**Pakistan** (base = frozen release):
- U0/U1 quantiles from named-category windows inside **2017-07-01..2017-12-31**.
- E1 fit on windows inside 2016-07-29..2017-12-31, for Independence Day and Eid al-Adha only.

## 11. Exact final-evaluation protocol (draft; not executed)

The full machine-readable draft is in `kaggle_training/stage3/outputs/final_protocol_draft.json`. It will be hashed and frozen only after review. Then a single runner script is written, hashed and run **once**. It refuses to run twice (lock file) or if any hash differs.

**US final:**
- **Products:** the 90 reserved products × 10 stores, launch-eligible.
- **Windows:** entirely inside **2015-11-01..2016-05-22**, origins every 7 days, horizons 7 and 28.
- **Base:** the frozen release served exactly. Parity on 300 sampled forecasts must be < 1e-3 units.

**Pakistan final:**
- **Series:** 15 named categories, plus the uncategorised group reported separately.
- **Windows:** inside **2018-01-01..2018-08-28**, every 7 days.
- Event dates are confirmed from official notifications and recorded before the run.

**Criteria, unchanged from the approved Q4 except where marked:**

| Capability | Pass criteria (all must hold) |
|---|---|
| E1c / Pakistan E1 | Event-window WAPE ≥5% better than the frozen release at both horizons. Non-event and overall WAPE no worse than +0.5 points. Absolute event bias does not grow. Date-block **and** product/category-cluster 95% intervals of the improvement exclude 0. At least 2 occurrences per event in the fit data. Occurrence counts reported. |
| Totals uncertainty (per selected cell) | Coverage within ±5 points (±10 rare) in event and non-event windows. At least 200 windows and 30 series. Date-block interval reported. |
| Decision protection (per selected cell) | Coverage within ±5 (±10 rare) on every (L,R) pair and both scenarios at κ=1. *[If adopted: also κ ∈ {0.5, 1.5} on (7,7).]* Lost units, end stock and shortage before arrival reported against D0. |
| Scope | Passing authorises a suggestion **only** for the evaluated market, segment, horizon and level. US results do not transfer to Pakistan or to the app's stores. |

**Reporting.** Every candidate, cell and failure is reported, along with the stockout-flag sensitivity, occurrence counts, and the shared-date dependence (date-block intervals).

## 12. Limitations and scope

**Data:**
- M5 2015-11..2016-05 was already *seen* through other products, so the US final run tests unseen products, not an unseen period.
- Development selection used a single SEL period with one occurrence of each primary event.
- The research copies are smaller than production (20/29/46 products against 53).

**Methods:**
- Amendment A1 and the D2c variant reuse SEL: a second look, disclosed.
- κ and scenario settings for the decision track were set in the script before running, but after the uncertainty results were seen.

**Pakistan:**
- One marketplace, recorded orders including cancellations, category level only.
- Event dates are approximate until confirmed.
- No SKU advice and no claim about Pakistani stores.

**Stock-outs:** unknown in both datasets. Lost units are lower bounds and coverage upper bounds.

**Production:** nothing in production changes until a later implementation review.

## 13. Decisions requested

| # | Question | My recommendation |
|---|---|---|
| D1 | Carry E1c (the 25 December closure rule) into the US final evaluation? | Yes, for reporting under the E1 gates. Long term, closures should come from the seller calendar (§3 of the proposal), not a learned layer. |
| D2 | Decision-protection selection: frozen κ=1 rule (D1 in three cells) or κ-robust rule (D2c for regular/occasional 90%; no regular 80% suggestion)? | **κ-robust rule**, disclosed as a correction made after development results, because D1 fails in a common situation (stock above forecast). |
| D3 | Pakistan E1 in the final run: only events with ≥2 fit occurrences (Independence Day, Eid al-Adha), α=10? | Yes, labelled. Report the other events unadjusted. |
| D4 | Approve the calibration plan (§10) and the final protocol draft (§11) for freezing? | Yes, after D1–D3 are applied. |
