# Inventory AI — sequential purchasing evaluation: protocol (frozen, executed)

Status: **frozen 2026-10-14 on the owner's direct instruction (sha `87578ccc…c97b`) and executed once; no cell passed.** Results: `docs/inventory-stage3-sequential-results.md`. The text below is the protocol as frozen.

History before freezing:
- The reservation has been made, from metadata only. Nothing reserved has been read.
- The development rehearsal and the engine parity check are done.
- The protocol file `kaggle_training/stage3/outputs/seq_protocol.json` is still a **draft**. It is frozen with `freeze_seq_protocol.py --freeze` after clearance; its hash then becomes the `--confirm` value.

**Governance:**
- AI purchasing protection stays research-only under amendment F1.
- A passed cell authorises only an implementation review of optional, seller-approved advice for that segment and level. `promotion_authorised` is false in every result.
- There are no new candidates: only the frozen A2 selections of protocol v1 (`8c385172…`) are tested.

The superseded draft (`docs/inventory-stage3-sequential-protocol-draft.md`) is kept for the record.

## 1. Question and candidates

Ordering repeatedly over many review cycles is replayed on real daily demand. The question is whether the frozen AI protection reduces lost sales enough to pay for the stock it holds, **and** whether it does better than the seller's own safety stock.

| Policy | Role |
|---|---|
| D0: the Stage 2 quantity on the point forecast (A1 spreading), safety stock 0 | Baseline |
| S(k): the same with a seller-set safety stock of k days of average daily sales (the 28 days before the replay), fixed at the start, k ∈ {2, 4, 7, 10, 14} | The existing seller policy; a cost-versus-shortage curve |
| regular 90% D2@0.9; occasional 90% D2c@0.9; rare 80% D2c@0.8; rare 90% D2c@0.9; short history 80% and 90% D2c | Frozen A2 candidates. The p-quantile of the Stage 2 quantity over 100 analogue demand paths; D2c zeroes 25 December. |

A cell's method is used at a review only when the product is in that segment at that review; otherwise the cell uses D0. The cell is evaluated on the series in its segment at the start of the replay.

## 2. Replay

- **Length and configurations.** 182 days per series. Configurations: (L, R) ∈ {(3, 7), (7, 7), (3, 14), (7, 14), (14, 7)} and κ ∈ {0.5, 1, 1.5}, with κ = 1 primary.
- **At each review day t:**
  - the frozen release `nexus-v2-shared-20261008` is served on the history up to t (the app's code; parity with `ml/v2` is checked);
  - every policy orders with the **Stage 2 engine's own minimum-quantity rule**, including open orders and their arrival days;
  - the order is usable on day t + L + 1 (A2);
  - if T28 < T7, no policy orders at that review (the engine gives no quantity).
- **Every day:**
  - deliveries usable that day join the stock;
  - demand is the actual daily sales;
  - unmet demand is lost (A3). Lost sales are a lower bound where stock-outs are unknown;
  - end-of-day stock is held.
- **Starting stock:** κ × the forecast for the first L + 1 + R days.
- **Values:** the M5 weekly sell price stands in for unit value, because cost is not in the data. Ordering cost is not modelled. Pack size and minimum order are both 1.
- **Engine fidelity (G6):** sampled decisions are recomputed by `backend/lib/replenishment/engine.js` and must be **equal exactly**. Development result: **3,744 of 3,744 identical**.

## 3. Assumptions and gates (all six must hold for a cell)

**Primary assumptions:**
- margin m = **30%** (the profit lost per unit of lost sales);
- holding cost h = **25% a year**.

Net benefit = m × value of avoided lost sales − h/365 × extra stock value-days.

**Sensitivity grid** (reported only; the primary pair decides): m ∈ {15, 30, 45}% × h ∈ {15, 25, 40}%.

| Gate | Requirement |
|---|---|
| G1 | ≥ 30 series and ≥ 200 series × pair replays |
| G2 | Fewer lost units than D0 (pooled over the 5 pairs at κ = 1). The 95% intervals of the reduction from the product-cluster and 28-day date-block bootstraps (B = 1,000) are **both** above 0. |
| G3 | Net benefit > 0 at the primary assumptions, with both 95% intervals above 0 |
| G4 | **Better than the seller rule:** at the candidate's stock-holding value, the S(0–14 days) curve (linear interpolation) loses at least as much sales value. A candidate holding more than S(14) fails, because no larger seller rule was tested. |
| G5 | At κ 0.5 and 1.5 the reduction and the primary net benefit stay above 0 |
| G6 | ≥ 2,000 sampled final-run decisions equal the application engine exactly |

## 4. Data

| Period | Data |
|---|---|
| Development | The consumed 180 and development_extra 150 products × 10 stores (guarded loaders, days ≤ 2015-10-31). Replay 2015-05-03 → 2015-10-31. |
| Final | Reservation `nexus-stage3-seq-m5-v1` (`outputs/reservation_seq_m5.json`, sha `419efa3e…`). 150 products (50 per category) × 10 stores, drawn seeded from the 2,629 M5 products **no earlier stage has read**, using item ids and categories only. Replay 2015-11-23 → 2016-05-22. |

**Reservation protection:**
- The development loaders refuse the reserved products.
- Only `seq_final_access` reads them, behind the run lock.
- Series with fewer than 28 days of history are excluded and reported, never replaced.

## 5. Development rehearsal (cloud; not evidence, selects nothing)

3,271 series:
- 1,839 occasional;
- 1,031 rare;
- 268 regular;
- 80 short history;
- 53 dormant;
- 28 excluded.

**All series, κ = 1, pooled over the pairs:**

| Policy | Fill rate | Stock-holding (million unit-days) |
|---|---|---|
| D0 | 80.2% | 23.8 |
| S2 | 85.5% | 29.0 |
| S4 | 89.1% | 34.5 |
| S7 | 92.1% | 43.1 |
| S10 | 93.8% | 51.8 |
| S14 | 95.0% | 63.8 |

**Candidates on their own segments:**

| Cell | Series | Fill rate D0 → candidate | Stock held | Net benefit (30%, 25%) | Lost-sales value: candidate vs seller rule at the same stock | Extra unit-days per avoided unit |
|---|---|---|---|---|---|---|
| regular 90% | 268 | 0.831 → 0.936 | 1.82× | +81,276 | 193,137 vs 149,172 | 44.6 |
| occasional 90% | 1,839 | 0.791 → 0.921 | 2.16× | +194,782 | 383,965 vs 325,317 | 69.9 |
| rare 80% | 1,031 | 0.752 → 0.816 | 1.58× | +14,642 | 161,891 vs 131,236 | 94.3 |
| rare 90% | 1,031 | 0.752 → 0.869 | 2.44× | +23,464 | 109,586 vs 111,054 (holds more than S14) | 129.5 |
| short history 80% | 80 | 0.790 → 0.837 | 1.38× | +2,812 | 28,117 vs 23,902 | 64.6 |
| short history 90% | 80 | 0.790 → 0.868 | 1.88× | +4,023 | 22,081 vs 15,891 | 97.5 |

**Reading:**
- In development every candidate cuts lost sales, and at 30% margin and 25% holding cost pays for its extra stock (G2, G3 and G5 hold).
- But the seller's simple safety stock reaches the same protection with **less** stock in every cell, so **G4 fails everywhere**.
- G6 shows as false in the development file only because parity is checked separately there; it is exact.
- If the final run behaves the same, no AI protection is promoted. The deterministic recommendations and the seller-set safety stock remain the product.
- This expectation does not change any gate.

## 6. Execution (owner's laptop, after clearance)

```
cd kaggle_training\stage3\sequential
python freeze_seq_protocol.py --freeze                     (once; prints the protocol sha)
..\..\..\ml\venv\Scripts\python.exe seq_final.py preflight --out <empty dir>
..\..\..\ml\venv\Scripts\python.exe seq_final.py execute-once --confirm <protocol sha> --lock-dir <persistent dir> --out <empty dir>
```

**Preflight checks (S1–S5):**
- S1: the environment pins and Node.js;
- S2: every listed file hash (code compared with LF line endings);
- S3: reservation integrity;
- S4: a 30-product development rehearsal with forecast parity < 1e-3;
- S5: engine parity on ≥ 2,000 decisions.

**The one-time run then:**
- creates an `O_EXCL` lock and reads the reserved products;
- re-checks engine parity on its own decisions;
- writes `results.json`, `REPORT.md`, `STATUS.json` and a self-verified `SHA256SUMS`.

An aborted run keeps its lock and evidence and is never restarted.
