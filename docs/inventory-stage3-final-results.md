# Inventory AI — Stage 3 final evaluation results (one time)

Status: **completed once on 2026-10-13 on the owner's laptop and submitted for implementation review.**
- Nothing below changes production: `nexus-v2-shared-20261008`, routing and `replenishment-1` are unchanged.
- A passed gate authorises **only an implementation review** for that market, segment, horizon and level.
- Decision-protection results are **research-only** (amendment F1): `promotion_authorised: false` in every cell.

## 1. Run integrity

| Item | Value |
|---|---|
| Protocol v1 / F1 / F2 | `8c385172…` / `9cbdec8f…` / `93cb6e47…` |
| Package manifest v2 | `6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e` |
| Calibration freeze (laptop) | `7ea548e2d32f9da22d4a9a58a5e708778dbdf39e1de0f1cc94fc150c47ab6af1` |
| Machine | Owner's laptop, app `ml/venv`: Python 3.12.4, numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1, Windows 10; pinned, no override |
| Automatic preflight (F2) | **24/24 passed** in 309 s, before the lock |
| Lock | `STAGE3_FINAL_EVALUATION.lock` created 15:53:48 UTC; `.lock.completed` written; no `.aborted` |
| Evaluation | 756 s; `STATUS.json` = `COMPLETED`, `reserved_outcomes_accessed: true`; console error output empty; no traceback |
| `SHA256SUMS` | sha256 `16d1d9a691a6aad8e30a2942e8c2e93dcdcdb414e3e5f6ab4850f84de38547c1`; all 8 listed files verified (on the laptop and again here) |
| Parity of the frozen release | US max \|diff\| 1.4e-14 units (49,500 windows); Pakistan 3.6e-12 |
| Evidence in the repo | `kaggle_training/stage3/outputs/final_results/evaluation/` and `…/lock/` (bytes preserved; `-text` in `.gitattributes`) |

Run once only. Nothing was retrained, substituted or restarted.

## 2. Summary of outcomes

| Capability | Result | Consequence |
|---|---|---|
| US event layer E1c | **Fail** | Not integrated. Events stay seller-declared calendar assumptions. |
| Pakistan event layer E1 (Independence Day, Eid al-Adha) | **Fail** | Not integrated. Eid and other holidays stay context only (`effect not_known`). |
| US totals uncertainty | **12 of 20 cells pass**: regular, occasional and rare × 7/28 days × 80/90% | Candidate for implementation review in those 12 cells only |
| US totals uncertainty: dormant and short history | **Fail** (8 cells) | No range shown; existing forecast only |
| Pakistan totals uncertainty | Descriptive only (by protocol) | No range shown for Pakistan |
| Decision protection (A2, research-only) | Research checks met in 2 of 6 selected cells (occasional 90%, rare 90%) | No promotion. Sequential inventory evaluation and an acceptable-cost decision are required first (batch 5). |

## 3. US event layer E1c (US windows 2015-11-01 … 2016-05-22; Thanksgiving, Christmas, New Year, Easter)

| Horizon | Windows (event) | Event WAPE base → E1c | Relative event improvement | Overall WAPE base → E1c | Event bias base → E1c | 95% intervals (date block; product cluster) |
|---|---|---|---|---|---|---|
| 7 days | 26,100 (8,100) | 42.16 → 41.85 | **0.73%** | 40.46 → 40.37 | 2.35 → 0.83 | [0.000, 0.018]; [0.001, 0.012] |
| 28 days | 23,400 (13,500) | 30.04 → 30.00 | **0.12%** | 29.46 → 29.44 | −1.38 → −2.28 | [0.000, 0.003]; [−0.001, 0.004] |

Gate checks:

| Check | Result |
|---|---|
| ≥ 5% event improvement at both horizons | **Fail** |
| Overall and non-event WAPE no worse than +0.5 points | Pass |
| \|event bias\| not larger | **Fail** at 28 days |
| Intervals exclude 0 | **Fail** |

The layer is harmless but adds almost nothing.

## 4. Pakistan event layer E1 (windows 2018-01-01 … 2018-08-28; 15 named categories)

| Horizon | Adjusted event windows | Event WAPE base → E1 | Relative improvement | Other WAPE base → E1 | Event bias base → E1 | 95% intervals (date block; category cluster) |
|---|---|---|---|---|---|---|
| 7 days | 45 | 59.75 → 56.46 | **5.5%** | 75.72 → 75.96 | −25.8 → −18.1 | [0.008, 0.072]; **[−0.110, 0.169]** |
| 28 days | 45 | 36.54 → 36.11 | **1.2%** | 70.39 → 70.44 | −27.9 → −11.2 | [0.012, 0.012]\*; **[−0.502, 0.293]** |

Gate checks:

| Check | Result |
|---|---|
| ≥ 5% at both horizons | **Fail** (28 days) |
| Category-cluster intervals exclude 0 | **Fail** |
| Bias not larger | Pass |
| Other windows no worse than +0.5 points | Pass |
| ≥ 2 fit occurrences | Pass |

The adjustment reduces the under-forecast bias around these events, but the improvement is not reliable across categories.

\*The 28-day date-block interval is a single value, which is consistent with all adjusted 28-day windows falling in one date block. It does not affect the outcome.

**Pakistan base accuracy (descriptive):** named categories WAPE 74.9 (7 days) and 68.6 (28 days); uncategorised 149.7 and 178.2 (34 and 31 windows). This is the frozen release's accuracy on held-back Pakistan data, and it is weak. No accuracy claim should be made for Pakistan.

**Pakistan totals uncertainty (descriptive only):**

| Level | Coverage (U0 / U1) | Relative widths | Verdict |
|---|---|---|---|
| 80%, 7 days | 0.81 / 0.80 | 0.66–0.73 | On target |
| 90%, 7 days | 0.96 / 0.95 | 2.6–2.8 | Over-covers with very wide ranges |
| 80%, 28 days | 0.90 | 1.9–2.3 | Over-cover and outside tolerance |
| 90%, 28 days | 0.96–0.98 | 5.1–5.7 | Over-cover and outside tolerance |

## 5. US totals uncertainty (one-sided upper p-quantile; tolerance ±5 points, rare ±10; event and non-event windows; ≥ 200 windows and ≥ 30 series)

Methods:
- **U0**: historical-error quantiles;
- **U1**: conformal;
- **U2**: conformalised quantile boosting (the stored boosters);
- **U3**: TSB bootstrap for rare products.

| Segment | Days | Level | Method | Windows / series | Coverage all | Event | Non-event | Mean relative width | Gate |
|---|---|---|---|---|---|---|---|---|---|
| regular | 7 | 80% | U0 | 2064 / 118 | 0.792 | 0.807 | 0.785 | 0.27 | **Pass** |
| regular | 7 | 90% | U0 | 2064 / 118 | 0.903 | 0.908 | 0.900 | 0.46 | **Pass** |
| regular | 28 | 80% | U0 | 1822 / 113 | 0.816 | 0.794 | 0.845 | 0.25 | **Pass** |
| regular | 28 | 90% | U0 | 1822 / 113 | 0.908 | 0.896 | 0.924 | 0.41 | **Pass** |
| occasional | 7 | 80% | U2 | 14984 / 647 | 0.793 | 0.809 | 0.786 | 0.35 | **Pass** |
| occasional | 7 | 90% | U0 | 14984 / 647 | 0.894 | 0.900 | 0.891 | 0.66 | **Pass** |
| occasional | 28 | 80% | U0 | 13430 / 637 | 0.799 | 0.806 | 0.788 | 0.32 | **Pass** |
| occasional | 28 | 90% | U0 | 13430 / 637 | 0.905 | 0.908 | 0.900 | 0.57 | **Pass** |
| rare | 7 | 80% | U3 | 8454 / 393 | 0.810 | 0.823 | 0.805 | 0.28 | **Pass** |
| rare | 7 | 90% | U3 | 8454 / 393 | 0.878 | 0.886 | 0.875 | 0.55 | **Pass** |
| rare | 28 | 80% | U0 | 7551 / 390 | 0.790 | 0.798 | 0.780 | 0.92 | **Pass** |
| rare | 28 | 90% | U1 | 7551 / 390 | 0.888 | 0.894 | 0.881 | 1.59 | **Pass** |
| dormant | 7 | 80% | none selected in development | – | – | – | – | – | Fail (no method) |
| dormant | 7 | 90% | none selected in development | – | – | – | – | – | Fail (no method) |
| dormant | 28 | 80% | none selected in development | – | – | – | – | – | Fail (no method) |
| dormant | 28 | 90% | U2 | 511 / 35 | 0.800 | 0.892 | 0.627 | 0.08 | Fail: non-event coverage |
| short history | 7 | 80% | U2 | 86 / 11 | 0.814 | 0.781 | 0.833 | 0.47 | Fail: < 200 windows, < 30 series |
| short history | 7 | 90% | U2 | 86 / 11 | 0.930 | 0.906 | 0.944 | 0.82 | Fail: < 200 windows, < 30 series |
| short history | 28 | 80% | U0 | 86 / 11 | 0.884 | 0.846 | 1.000 | 0.60 | Fail: non-event coverage, sample size |
| short history | 28 | 90% | U1 | 86 / 11 | 0.837 | 0.831 | 0.857 | 0.61 | Fail: event coverage, sample size |

These results are on the US (M5) held-back data. They show that the stated ranges achieved their coverage on that data. They are not a guarantee for an individual seller's products.

## 6. Decision protection — research-only (amendment F1)

**A2 κ-robust selections.** Coverage is checked in every scenario cell: 5 lead-time/review pairs × 2 scenarios, plus κ 0.5 and 1.5.

| Segment, level | Method | Decisions per cell | Coverage range | Coverage cells outside tolerance | Shortage avoided per decision | Extra stock per decision | Worst extra stock per avoided unit (stability cap) | Pooled shortage reduction, date-block 95% | Research checks |
|---|---|---|---|---|---|---|---|---|---|
| regular 90% | D2@0.9 | 1822 | 0.850–0.879 | 1: no-promotion scenario, L3/R7, 1548/1822 (needed 1549) | 2.42–5.50 | 8.57–17.44 | 4.31 (cap 5.13) ✓ | [3.07, 3.84] | **Not met** (by one decision) |
| occasional 90% | D2c@0.9 | 13430 | 0.893–0.920 | 0 | 0.81–1.74 | 4.04–7.42 | 5.43 (cap 7.06) ✓ | [1.08, 1.28] | **Met** |
| rare 80% | D2c@0.8 | 7551 | 0.806–0.870 | 0 | 0.02–0.24 | 0.41–1.08 | **22.38 (cap 19.61) ✗** | [0.07, 0.12] | **Not met** (stability) |
| rare 90% | D2c@0.9 | 7551 | 0.854–0.912 | 0 | 0.14–0.39 | 1.28–2.32 | 9.27 (cap 11.29) ✓ | [0.21, 0.26] | **Met** |
| short history 80% | D2c@0.8 | 86 | 0.744–0.802 | 3 | 0.97–2.69 | 1.58–4.50 | 2.35 (cap 8.05) ✓ | [0.82, 3.02] | **Not met** (< 200 decisions, coverage) |
| short history 90% | D2c@0.9 | 86 | 0.791–0.895 | 6 | 1.49–3.13 | 4.24–7.22 | 3.02 (cap 9.80) ✓ | [1.15, 3.69] | **Not met** (< 200 decisions, coverage) |

Cells with no selection are reported with no result: regular 80%, occasional 80%, and dormant at both levels.

In total, 23,375 decisions were evaluated. 25 inconsistent decisions were skipped. Path sources: 23,351 own, 15 pooled and 9 point-only.

**Every selected method reduces shortages, but at a cost.** Each avoided unit of shortage costs 1.3–22.4 units of extra stock held at the end of the cycle, depending on the cell. The middle of that range is about 3–6 for regular and occasional products and 6–9 for rare products at 90%. Whether that cost is acceptable is a business decision. The one-cycle replay cannot settle it. This is why promotion waits for the sequential evaluation (batch 5).

**A0 original selections (disclosure only).** They give the same picture:
- regular 80% and 90% (D1), occasional 90% (D1), rare 80% and 90%: checks met;
- occasional 80% (D2c): 2 coverage cells outside tolerance, at 0.856 and 0.851 against a maximum of 0.85;
- short history: not met.

A0 never authorises anything.

## 7. Decision (architect, 2026-10-13) and what was built

The final evaluation is accepted. A bounded release follows (`docs/forecast-upper-estimates.md`):

1. **Upper demand estimates.** The display shows the existing forecast beside an 80% or 90% **one-sided upper demand estimate** in the 12 passing cells, with the exact evaluated method.
   - The final evaluation measured only whether actual demand stayed at or below the upper estimate. So it is never shown as a "likely demand range", and the point forecast is never used as a lower bound.
   - It is not a guarantee and not an order quantity.
2. **Applicability is enforced on the server.**
   - A US country alone does not establish it: the store profile and the product department must match the benchmark.
   - Dormant products, short history, Pakistan and unsupported markets or product profiles get a reason and keep the existing forecast.
   - Every display says "Evaluated on US Walmart benchmark data; not calibrated to your store."
3. **Event layers.** Neither E1c nor Pakistan E1 is integrated. The seller calendar is the event mechanism:
   - holidays show "Effect unknown";
   - seller % changes are labelled "Assumed by you";
   - closures and supplier delays are labelled as declared by the seller.
4. **Safety stock.** Seller-set safety stock stays. AI purchasing protection stays research-only under F1, pending a separate sequential inventory-evaluation protocol and an acceptable-cost decision.

Every failed result above and the consumed final evaluation are preserved unchanged.
