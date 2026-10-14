# Inventory AI — sequential purchasing evaluation: final results

**Outcome: no AI purchasing-protection cell passed.** The product keeps the deterministic replenishment recommendations and the seller-set safety stock. AI protection stays research-only (amendment F1); nothing was integrated, and no gate was changed or retuned.

| Run record | Value |
|---|---|
| Protocol | `nexus-stage3-seq-protocol-v1`, frozen 2026-10-14 on the owner's direct instruction; sha `87578ccc…c97b` |
| Run | Owner's laptop, one time, 2026-10-14 11:41–11:42 UTC. Preflight S1–S5 passed. Status `COMPLETED`; lock kept. |
| Evidence | `kaggle_training/stage3/outputs/sequential_final/` (`REPORT.md`, `results.json`, `STATUS.json`, `run.log`, `parity_result.json`, `preflight_report.json`, `SHA256SUMS` sha `dcbd1a18…b23d`; verified OK) |
| Data | Reservation `nexus-stage3-seq-m5-v1`, replay 2015-11-23 → 2016-05-22. 1,498 series; 2 were excluded for having under 28 days of history and were not replaced. |
| Fidelity | Forecast parity with `ml/v2` max \|diff\| 1.4e-14; engine parity 3,005 / 3,005 exact |

## Cells (κ = 1, pooled over the five (L, R) pairs; margin 30%, holding 25% a year)

| Cell | Series | Lost units D0 → candidate | Stock held vs D0 | Net benefit | Lost-sales value: candidate vs seller rule at the same stock | Failed gates |
|---|---|---|---|---|---|---|
| regular 90% | 162 | 122,923 → 45,809 | 1.74× | +54,293 | 130,076 vs 100,043 | G4 |
| occasional 90% | 822 | 146,845 → 53,234 | 2.11× | +89,460 | 198,196 vs 139,468 | G4 |
| rare 80% | 490 | 25,686 → 16,262 | 1.64× | +13,849 | holds more than S14 | G4 |
| rare 90% | 490 | 25,686 → 12,418 | 2.36× | +16,310 | holds more than S14 | G4 |
| short history 80% | 8 | 648 → 506 | 1.15× | +162 | 2,111 vs 1,997 | G1, G4 |
| short history 90% | 8 | 648 → 447 | 1.25× | +221 | 1,867 vs 1,619 | G1, G4 |

## What the results mean

Every candidate cut lost sales and paid for its extra stock (G2, G3 and G5 hold). However, a plain seller safety stock of a few days' sales reached the same protection with less stock in every cell, so G4 fails throughout. This repeats the development rehearsal.

The finding for sellers: if you want fewer stock-outs, raise the safety-stock days in Replenishment settings. The scenario panel shows the cost in stock of doing so.

**Limits:**
- These results come from the M5 benchmark (Walmart), not from a seller's store.
- Sell price stands in for unit value, and ordering cost is not modelled.
- Where stock-outs are unrecorded, lost sales are a lower bound.
- The reservation has now been read. It cannot be used to test the same question again.
