# Inventory AI — Stage 3 one-time final-evaluation package

Status: **cleared and executed once on 2026-10-13 (COMPLETED; results in `docs/inventory-stage3-final-results.md`). The lock is held; the evaluation cannot be rerun.** Production is unchanged: `nexus-v2-shared-20261008`, routing and `replenishment-1`.

## 1. What is frozen

| Item | sha256 |
|---|---|
| Final protocol v1 (`outputs/final_protocol.json`; lists 42 files) | `8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af` |
| Amendment F1 — decision protection research-only (`outputs/final_amendment_F1.json`) | `9cbdec8fe37646c2967afc09ad5cb04a3eba5559f1cc4c73a962f997a6e64223` |
| Amendment F2 — final-machine reproduction preflight (`outputs/final_amendment_F2.json`) | `93cb6e474e29d8b03a03cdbbfbcf271cfffa407c71e9bb9dbbcdc8fa617036b5` |
| Package manifest **v2** (`outputs/final_package_manifest.json`) | `6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e` |
| Package manifest v1, superseded (`outputs/final_package_manifest_v1.json`) | `764ed1c73de7dcbf373bea7ce59c45b0ca6aad9e99590016c512ed43de1d08c5` |
| Calibration freeze, laptop run (`outputs/final_prep/verification/laptop_run/calibration/calibration_freeze.json`) | `7ea548e2d32f9da22d4a9a58a5e708778dbdf39e1de0f1cc94fc150c47ab6af1` |
| Pakistan source file (checked by bytes; not in the package) | `103727e1c7a1670003de5102f25c33734f5cb1a988526ec264c8aec79fb39fb9` |

**Calibration:** the verified laptop calibration (the app's ML environment) is accepted.

**U2 boosters:** the selected boosters are preserved as stored. Their hashes are in protocol v1. They are never retrained or substituted.

**The package manifest adds these files to the 42 in protocol v1:**
- F1 and F2;
- `final/preflight.py` and `final/final_execute.py`;
- the four calibration artifacts and the calibration freeze.

The protocol-v1 runner functions are used unchanged.

**Manifest v2 (2026-10-13).** Only the entry point `final/final_execute.py` changed (now `9ae1199b…`). The fix concerns output finalisation: v1 wrote the last `run.log` line after `SHA256SUMS`, so the checksum list did not verify. v2 writes, in this order:
1. the last log line, then closes the log;
2. `STATUS.json` (`PREFLIGHT_PASSED`, `PREFLIGHT_FAILED`, `COMPLETED` or `ABORTED`; whether reserved outcomes were accessed; whether a lock was created);
3. `SHA256SUMS` over every other file, which is then self-verified.

An exception during the evaluation writes `ABORTED_TRACEBACK.txt`, finalises as `ABORTED` and leaves `<lock>.aborted`; the lock is never released for a rerun. Protocol, amendments, preflight, calibration and boosters are unchanged; the update script refuses any other change.

## 2. Amendment F1 — decision protection is research-only

- **The excess cap becomes a stability check.** The development-relative excess-stock cap (5/4 × the worst development ratio) is renamed a **research stability check**. It shows whether final behaviour stays within development behaviour. It is not an acceptable-cost criterion.
- **No decision-protection result authorises anything.** All decision-protection results (A2 and A0) are computed and reported exactly as in protocol v1, but none, pass or fail, authorises a safety-stock suggestion, a promotion or a production change. Every result carries `promotion_authorised: false`.
- **What promotion would require later**, in a future protocol with its own reservation:
  1. A **sequential inventory evaluation**: a multi-cycle replay with the Stage 2 engine, covering carried stock, open orders, lead times and review cycles.
  2. An **acceptable-cost criterion** fixed in advance.
- **Gates that stay unchanged:** the protocol-v1 gates for US E1c, US totals uncertainty and Pakistan E1. Passing one authorises only an implementation review for that scope.

## 3. Amendment F2 — final-machine reproduction preflight

The preflight runs before the lock and before any reserved outcome is accessed. It uses development data only. It never retrains or substitutes an artifact: values it recomputes are compared and then discarded. **Any failure stops the run.**

| Check | What it verifies | Tolerance |
|---|---|---|
| P1 | Python 3.12; numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1 (the frozen calibration environment) | Exact |
| P2a–e | Protocol v1 hash; its 42 files; manifest and its files; calibration freeze and artifacts; Pakistan source bytes | Exact sha256 |
| P3 | Research copy R14 re-serves the development CAL and SEL frames: same rows, groups, methods and actuals; parity with `ml/v2` `forecast_totals` | Forecasts \|ΔF\| ≤ 1e-6 units; parity < 1e-3 |
| P4 | Selected U2 boosters' SEL prediction hashes equal the development hashes (`705b57d7…`, `d847edf0…`, `981e6aaa…`, `cb1bf46c…`) | Exact sha256 |
| P5 | The frozen release re-serves the US and Pakistan calibration windows; parity | \|ΔF\| ≤ 1e-6; parity < 1e-3 (US), < 1e-2 (Pakistan) |
| P6 | Recomputed U0/U1 quantiles, U2 corrections, D1 r_p, counts and Pakistan E1 β | Quantiles ≤ 1e-9; β ≤ 1e-8; counts exact |

**Values observed so far** (calibration laptop against the development machine):
- forecasts and quantiles: identical;
- Pakistan β: differs by 5.6e-17;
- U2 prediction hashes: identical.

## 4. Preflight and rehearsal results so far

| Run | Environment | Result |
|---|---|---|
| Reference preflight from the unzipped package (manifest v1) | Development machine (unpinned, reference only; P1 overridden and marked) | **23/23 passed** in 101 s |
| Reference preflight, manifest v2 | Development machine (unpinned, reference only) | **23/23 passed** in 104 s; `STATUS.json` = `PREFLIGHT_PASSED`; `sha256sum -c SHA256SUMS` all OK |
| Negative tests | Development machine | Wrong manifest sha, wrong environment and a missing Pakistan file each **stopped before the lock**; no lock file was created |
| Rehearsal (`rehearse`: full chain on development stand-ins, no reserved data) | Development machine | Completed: preflight passed, protocol-v1 evaluation ran, results relabelled per F1, report and SHA256SUMS written |
| **Preflight on the final machine (owner's laptop), manifest v2** | App `ml/venv` (Python 3.12.4, numpy 1.26.4, pandas 2.2.2, scipy 1.17.1, xgboost 3.4.1; Windows 10), pinned, no override | **24/24 passed** in 221 s; `STATUS.json` = `PREFLIGHT_PASSED`, reserved outcomes not accessed, no lock; `SHA256SUMS` sha256 `c91870c76bc2bb99b140e26bfc491edd3a826ed1254a8489f86a6a44714d9882`, all 3 files verify. Evidence: `outputs/final_prep/final_package_checks/laptop_preflight_v2/`. Cleared by the architect. |
| **One-time final evaluation** | Owner's laptop, same environment | **COMPLETED**: automatic preflight 24/24, lock created, 756 s; `SHA256SUMS` `16d1d9a6…`; see the results doc |

## 5. Commands

Run from the unzipped `nexus_stage3_final_package.zip`, folder `nexus_stage3_package/repo/kaggle_training/stage3/final`, with `ml\venv\Scripts\python.exe`. Use a new empty `--out` folder each time. The v2 package is `nexus_stage3_final_package.zip` (45.2 MB, content digest `4b6e6177…`), built on the laptop in `stage3_local\run\final_package_v2`.

**Preflight** (to run now):
```
python final_execute.py preflight --manifest-sha 6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e --calibration ../outputs/final_prep/verification/laptop_run/calibration --calibration-freeze-sha 7ea548e2d32f9da22d4a9a58a5e708778dbdf39e1de0f1cc94fc150c47ab6af1 --pakistan-source "<Pakistan Largest Ecommerce Dataset.csv>" --out <empty folder>
```

**One-time evaluation** (only after approval):
```
python final_execute.py execute-once --confirm 8c385172f651bef23b40cbb75a8508af8d3ffbc62c54781914406c3472a445af --manifest-sha 6c11d581e14427a97d690582606128471c350097f0ecee2ffc93d07ba75d440e --calibration ../outputs/final_prep/verification/laptop_run/calibration --calibration-freeze-sha 7ea548e2d32f9da22d4a9a58a5e708778dbdf39e1de0f1cc94fc150c47ab6af1 --pakistan-source "<csv>" --lock-dir <persistent folder> --out <new empty folder>
```

**Rerun protection:**
- The run checks all hashes and reruns the full preflight.
- It refuses a non-empty output folder.
- It creates the lock with `O_CREAT|O_EXCL`, so a second start in the same lock folder is refused.
- Every output ends with `STATUS.json` and a self-verified `SHA256SUMS`; check with `sha256sum -c SHA256SUMS`. On Windows the list is written with CRLF line endings (hashes are of the file bytes and are correct); on Linux check with `tr -d '\r' < SHA256SUMS | sha256sum -c -`.
- The returned evidence is accepted once, matched to the protocol, manifest and calibration-freeze hashes.
