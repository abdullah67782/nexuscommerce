# U2 boosters: cross-machine reproducibility (development data only)

**Verdict: not blocking.** The calibration and the final evaluation use only the stored, hashed, selected U2 boosters. They are never retrained. On both machines those boosters give bit-identical predictions and identical calibration.

## Machines

| Machine | Platform | Libraries |
|---|---|---|
| Development | Linux | Python 3.13, numpy 2.5.3, xgboost 3.4.1 built from the official v3.4.1 source tag |
| Owner's laptop | Windows 10, app `ml/venv` | Python 3.12.4, numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1 Windows wheel |

## Findings

**Inputs are identical.** The stored development frames reproduce exactly on the laptop (FIT_A, FIT_B, CAL, SEL: 0 rows differing).

**Inference is identical.** The selected boosters' SEL predictions have the same hash on both machines (for example 705b57d7… for h=7, p=0.8). Every US calibration quantile, U2 correction and D1 r_p is identical. The Pakistan rows are identical, and the E1 β differs by at most 5.6e-17.

**One feature differs in the last bit.** The laptop's `np.log1p(F)` differs by 1 ULP:

| Horizon | Fit rows differing | SEL rows differing |
|---|---|---|
| h = 7 | 16,083 of 261,863 | 6,309 |
| h = 28 | 8,151 of 245,422 | 3,057 |

This does not change the selected boosters' predictions on SEL.

**Training is not reproducible across builds.** The laptop was given the development machine's exact `log1p` values, so its training matrices were bit-identical to development (X sha ff004ba3… and 859200b0…). Its retrains still differ:
- with the frozen recipe;
- without row sampling (subsample = 1.0);
- with n_jobs 1 and 2.

Within one build, training is deterministic: on the development machine, n_jobs 1 and 2 give identical results, and the retrain reproduces the selected boosters exactly. **The cause is the xgboost build or platform** (compiler and floating-point evaluation order in training), not the data, the method or the random sampling. XGBoost does not promise bitwise-identical training across builds.

**The practical effect is negligible** (laptop retrain against the selected boosters, development SEL coverage hits):

| Cell | Selected boosters | Laptop retrain | Windows |
|---|---|---|---|
| occasional, 7 days, 80% | 42,283 | 42,293 | 52,807 |
| short history, 7 days, 80% | 2,487 | 2,487 | 3,105 |
| short history, 7 days, 90% | 2,814 | 2,815 | 3,105 |
| dormant, 28 days, 90% | 2,062 | 2,062 | 2,295 |

## Consequences

- The selected artifacts are the stored files (hashes in `final_protocol.json`). The retrain recipe documents how they were made; it is not a way to recreate them bit for bit on another build.
- Any future retrain produces a new artifact. It needs its own version, hash and validation; it may not silently replace the selected boosters.
- **Added precondition for the final evaluation.** Before reading any reserved outcome, the final machine must reproduce the development SEL prediction hashes of the selected boosters and the calibration values. Any 1-ULP input difference that changes a prediction is then caught on development data.

## Evidence

- `laptop_run/`: the returned output ZIP (sha 2b0582b1…), checks, diagnostics 1 and 2.
- `cloud_diagnostics/`: development-machine references.
