# Inventory AI — Stage 3 final protocol and training/calibration package

Status: **protocol, candidates and runner frozen. The calibration package is ready to run on Kaggle. The final evaluation has not been run.**

| Item | Value |
|---|---|
| Final protocol | `nexus-stage3-final-protocol-v1` — `kaggle_training/stage3/outputs/final_protocol.json` |
| Protocol sha256 | `8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af` |
| Amendment A2 | `outputs/dev_protocol_amendment_A2.json` (κ-robust rule, disclosed) |
| Runner (frozen, not executed on reserved data) | `kaggle_training/stage3/final/final_runner.py` |
| Production | Unchanged: `nexus-v2-shared-20261008` (model hashes are in the protocol), routing, `replenishment-1`. No integration or model replacement is authorised. |

The protocol lists the sha256 of 42 files: code, app `ml/v2` code, production models, research copies, selected U2 boosters, M5 files, the Pakistan development extract, reservation, protocols and selections. The runner and the package refuse to run if any of them differs.

---

## 1. Architect decisions applied

| # | Decision | Applied as |
|---|---|---|
| D1 | Carry E1c into the US final run | Reported under the event gates. The learned E1 layer is not carried. |
| D2 | κ-robust selection | Amendment A2, disclosed. The original A0 selections are preserved and reported, but they do not authorise a suggestion. |
| D3 | Pakistan E1 restricted | Only Independence Day and Eid al-Adha, which have two fit occurrences each, with α = 10. |
| D4 | Freeze calibration plan and protocol | Done. Calibration artifacts are hashed before any final outcome is read. |

## 2. The four protocol corrections

### 2.1 Exact, unrounded thresholds

Every tolerance, count and ratio check uses integer or `Fraction` arithmetic in `final/common.py`.

- Coverage tolerance is checked as `|hits − p·n| ≤ tol·n`.
- No displayed (rounded) value is ever compared with a threshold.
- Results are stored as exact fractions plus a float for reading.

**This changed two statements in the development report** (see its §0):

| Cell | Report §6.3 said | Exact result |
|---|---|---|
| Regular 90% | A2 would select D2c@0.9 | D2c@0.9 reaches 0.848 at κ = 1.5, below 0.85. A2 selects **D2@0.9** (lowest coverage 0.851). |
| Occasional 80% | A2 would keep D2c@0.8 | D2c@0.8 reaches 0.852 at κ = 0.5, above 0.85. **No eligible candidate**, so no suggestion. |

The original development selections were rechecked exactly and are unchanged: all 20 totals cells and all 10 decision cells match.

### 2.2 Shortage and excess-stock promotion gate

For each selected (segment, level), every A2 cell must meet all of the following, computed exactly:

1. Shortage avoided per decision versus D0 is greater than 0.
2. `(mean end stock − D0 mean end stock) / (D0 mean lost units − mean lost units)` ≤ cap.
3. The date-block 95% interval of the pooled per-decision shortage reduction (κ = 1) is above 0.

**How the cap is set:** cap = 5/4 × the selected method's worst development ratio over its A2 cells.

**Why a 1.5 cap was not used:** a fixed cap of 1.5 units per avoided unit was checked first against development data. It would have failed every candidate (development ratios are 2–16), so the development-anchored cap was frozen instead (user decision).

| Cell | Method | Worst development ratio | Cap |
|---|---|---|---|
| Regular 90% | D2@0.9 | 4.102 (99459/24245) | 5.128 |
| Occasional 90% | D2c@0.9 | 5.645 | 7.057 |
| Rare 80% | D2c@0.8 | 15.686 | 19.607 |
| Rare 90% | D2c@0.9 | 9.029 | 11.287 |
| Short history 80% | D2c@0.8 | 6.442 | 8.053 |
| Short history 90% | D2c@0.9 | 7.836 | 9.795 |

### 2.3 Decision-specific quantities

Each method is evaluated on the order quantity it produces for each decision. `Q_method − Q_D0` is **not** a safety stock: with Stage 2's daily checkpoints, a safety-stock setting SS gives `max(−min balance, SS − end balance)`, which is not `Q_D0 + SS` in general.

The statement in report §6.4 ("safety stock = Q_method − Q_D0") is withdrawn. A later implementation must reproduce the evaluated quantity for each decision.

### 2.4 Complete executable protocol

`final/final_runner.py` implements every step: data access, serving, E1c, totals uncertainty, the decision track, Pakistan, every gate, bootstraps and reports.

**Validation:**
- **Decision track:** the final code re-ran the full development decision track and reproduced all 490 development cells exactly (decisions, hits, quantities, lost units, end stock, shortage before arrival).
- **Rehearsal:** the runner was rehearsed end to end on development stand-ins (`--rehearse`). That covers US development-extra products 2014-11..2015-05 and the Pakistan extract 2017-07..12. Run time was 386 s.
- Rehearsal output: `outputs/final_prep/rehearsal/`, labelled *REHEARSAL, not evidence*.

## 3. Frozen candidates

| Capability | Selection |
|---|---|
| US event | E1c (25 December closure on rows with F ≥ 1) |
| US totals uncertainty (20 cells) | As in development: U0 ×9, U2 ×4, U3 ×2, U1 ×2; dormant 7-day and 28-day/80% get none |
| US decision protection (A2, authorising) | Regular 80%: none · Regular 90%: D2@0.9 · Occasional 80%: none · Occasional 90%: D2c@0.9 · Rare: D2c@0.8, D2c@0.9 · Short history: D2c@0.8, D2c@0.9 · Dormant: none |
| US decision protection (A0, reported only) | Regular: D1@0.8, D1@0.9 · Occasional: D2c@0.8, D1@0.9 · Rare, short history: D2c · Dormant: none |
| Pakistan event | E1 for Independence Day and Eid al-Adha, α = 10, β fitted in calibration |
| Pakistan uncertainty | Descriptive only: 15 category series are below the 30-series requirement and are not inventory units |
| Targets | 80% and 90% |

**U2 boosters:**
- The selected boosters were re-created in the development environment from the development recipe.
- They reproduce the development selection-period upper bounds **exactly** (max difference 0).
- They are saved in `outputs/u2_selected/` with hashes.
- Thread count does not change them (`n_jobs` 1 and 2 give identical trees).

## 4. Gates (all must hold; a pass authorises a suggestion only for that market, segment, horizon and level)

| Capability | Gate |
|---|---|
| Event (E1c, Pakistan E1) | Event-window WAPE ≥ 5% better at both horizons. Overall and non-event WAPE ≤ +0.5 points. \|event bias\| not larger. Date-block and product/category-cluster 95% intervals above 0. At least 2 fit occurrences per adjusted event. |
| Totals uncertainty | Exact tolerance in event **and** non-event windows. At least 200 windows and 30 series. At least 2 distinct primary-event occurrences in the cell's event windows. |
| Decision protection | Exact tolerance in every A2 cell (5 pairs × 2 scenarios at κ = 1, plus κ = 0.5 and 1.5 on (7,7)). At least 200 decisions per cell. Shortage and excess-stock gate as in §2.2. |
| Parity | Max served − `forecast_totals` difference < 1e-3 units (US) and < 1e-2 units (Pakistan category totals), or the run stops. |

**Coverage** is the share of windows whose actual total is ≤ the method's upper p-quantile.

## 5. Calibration (development data only)

**US:**
- **Model and products:** the frozen release, served exactly, on development products (330 × 10 stores).
- **Windows:** inside 2015-06-01..2015-10-31, every 7 days.
- **Outputs:** U0/U1 quantiles, U2 conformal corrections (selected CPU boosters) and D1 r_p.

**Pakistan:**
- U0/U1 from 2017-07..12.
- E1 β fitted on windows inside 2016-07-29..2017-12-31, with α = 10.

**Pakistan 2018 event dates** (recorded before the final run):

| Event | Date |
|---|---|
| New Year | 2018-01-01 |
| Pakistan Day | 2018-03-23 |
| Labour Day | 2018-05-01 |
| Ramadan start | 2018-05-17 |
| Eid al-Fitr | 2018-06-16 |
| Independence Day | 2018-08-14 |
| Eid al-Adha | 2018-08-22 |

Lunar events keep the ±1-day spread until the day before.

**Cloud cross-check:** the same calibration was computed in the development environment and is stored in `outputs/final_prep/cloud_crosscheck/`. The Kaggle result (app-pinned libraries) is compared with it value by value when the ZIP comes back.

## 6. GPU policy

- The only trained research artifacts are the four U2 quantile boosters (h ∈ {7, 28}, p ∈ {0.8, 0.9}).
- The selected boosters are the CPU development artifacts. They are never replaced.
- Kaggle retrains them twice:
  - on **CPU**, to check reproducibility in the app's library versions;
  - on **GPU** (`device="cuda"`) as a **diagnostic only**. GPU histogram building and row sampling can produce different trees.
- Recipe, features and hyperparameters are identical in all three. GPU availability changes nothing in the method.
- Empirical calibration, bootstraps and the decision track run on CPU. They gain nothing from a GPU.
- If the Kaggle CPU retrain differs from the selected boosters, the difference is reported and investigated on development data before the final package. The selected boosters stay in use.

## 7. Kaggle training/calibration package

**Files to upload:**

| File | Kaggle action |
|---|---|
| `nexus_stage3_package.zip` (43 MB) | *Datasets → New Dataset* (private). Kaggle unpacks it. |
| `stage3_training_calibration.ipynb` | *Code → New Notebook → File → Import Notebook* |

**Notebook settings:**
- Add the dataset as input.
- Accelerator **GPU T4**. With *None*, the GPU check is skipped and everything else still runs.
- **Internet On.** It is used once, to install Python 3.12 with numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1 and scikit-learn 1.5.1, the app's pins, in an isolated environment.

**Cells:**

| Cell | Step | What it does |
|---|---|---|
| 1 | Paths | Finds the package and copies it to `/kaggle/working/nexus_repo` |
| 2 | Environment | Isolated Python 3.12 with the app pins |
| 3 | `env` | Versions, GPU detection; stops if versions differ from the pins |
| 4 | `verify` | Protocol hash and all 42 file hashes |
| 5 | `reproduce` | Re-serves FIT_A, FIT_B, CAL and SEL with R12/R13/R14; compares with the development values row by row; parity against `forecast_totals` |
| 6 | `u2_cpu` | CPU retrain compared with the selected boosters and with the development upper bounds |
| 7 | `u2_gpu` | GPU diagnostic, never selected; skipped without a GPU, and a GPU error never blocks the CPU path |
| 8 | `calibrate` | US and Pakistan calibration with the selected boosters |
| 9 | `package` | Report, manifest, `SHA256SUMS`, and `nexus_stage3_training_calibration_output.zip` |

**Return this file:** `nexus_stage3_training_calibration_output.zip`. It contains:
- the calibration artifacts;
- the CPU (and GPU) diagnostic boosters, plus an unchanged copy of the selected boosters;
- the checks, logs, environment, state files, protocol copy, report, manifest and `SHA256SUMS`.

The whole package was run self-contained in the development environment before release (unpinned libraries, no GPU). Every step passed, development frames were reproduced exactly, and the CPU retrain was identical to the selected boosters.

## 8. After the ZIP comes back (before any final outcome is read)

1. Check `SHA256SUMS`, the protocol hash, the environment pins and the step states.
2. Compare the reproduction and U2 checks.
3. Compare the calibration with the cloud cross-check, value by value. Any difference (expected only if the app-pinned numpy/pandas change a feature at the last bit) is explained on development data.
4. Write `calibration_freeze.json` (artifact hashes) and record its sha256.
5. Only then prepare the separate one-time final-evaluation package. It will contain:
   - the frozen runner;
   - the reserved-data loader;
   - the Pakistan source file (sha `103727e1…`);
   - `--confirm`, `--calibration-freeze-sha` and lock-file rerun protection.
