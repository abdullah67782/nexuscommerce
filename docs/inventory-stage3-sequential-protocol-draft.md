# Inventory AI: sequential inventory evaluation (draft protocol for architect review)

Status: **draft. Nothing has been run, no data has been read for it, and nothing is reserved yet.**

AI purchasing protection (D1, D2, D2c) stays research-only under amendment F1 until this protocol is approved, executed once and passes, and the owner has fixed an acceptable-cost criterion in advance. Production is unchanged: `replenishment-1`/`-2`, seller-set safety stock, forecast routing.

## 1. Question

For each segment and level where Stage 3 selected a protective method, ordering repeatedly over many review cycles is tested on real daily demand. Each method is compared with the plain Stage 2 quantity and with a simple seller-set safety stock. The test asks two things:

1. Does it reduce lost sales?
2. Does the extra stock it holds cost no more than an acceptable amount that the owner fixes **before** any result is seen?

The one-cycle replay of the final evaluation could not answer this. It did not carry stock and open orders from one cycle into the next, and it measured extra stock only at the end of a single window.

## 2. Candidates (no new research candidates)

| Policy | Role |
|---|---|
| **D0**: the Stage 2 quantity, seller safety stock 0 | Baseline |
| **S(k)**: Stage 2 quantity with seller-set safety stock = k days of the 28-day average, k ∈ {0, 2, 4, 7, 10, 14} | The existing feature; a cost-versus-shortage curve to compare with |
| **A2 selections, frozen:** regular 90% D2@0.9, occasional 90% D2c@0.9, rare 80% D2c@0.8, rare 90% D2c@0.9, short history 80/90% D2c | Candidates for promotion |
| A0 originals (D1 cells) | Disclosure only |

Dormant products and the A2 cells with no selection get no candidate.

## 3. Replay design

**Series and length.** Each series (product × store) is replayed day by day for 182 days, which is 26 weekly or 13 fortnightly reviews.

**Configurations.**
- Lead time L ∈ {3, 7, 14} days, review period R ∈ {7, 14} days.
- Pack size 1, minimum order 1.
- Orders are usable the day after they arrive (assumption A2).

**Starting stock.** κ × the forecast for the lead-time and review period, with κ ∈ {0.5, 1, 1.5}. κ = 1 is primary.

**Carried state.** On-hand stock, open orders and their arrival days carry from cycle to cycle. Demand is the actual daily sales.

**Lost sales.** Demand above on-hand stock is lost. M5 sales are censored by stock-outs, so lost units are a lower bound. This is reported, not corrected.

**Forecasts.** At each review, the frozen release is served on history up to that day (the app's own code, with the parity check from F2). Method paths are generated as in the final protocol, using frozen calibration values only.

**Engine fidelity.**
- The Stage 2 quantity comes from the application's engine (`backend/lib/replenishment/engine.js`, `replenishment-1`), called in batches through Node.
- If a Python port is used for speed, it must reproduce the JavaScript engine's integer quantities **exactly** on ≥ 2,000 sampled decisions before any outcome is computed.

**Metrics** per series × configuration × policy:
- lost units and fill rate (served ÷ demand);
- cycles with any shortage;
- average on-hand units and stock-holding unit-days;
- units ordered, number of orders, and stock at the end.

**Value-weighted versions.** These use the M5 sell price as the unit value. Prices are inputs, not targets.

## 4. Acceptable-cost criterion: the owner fixes it before any result

The proposed form is a net-benefit test (it can be swapped for a simple cap):

> Net benefit = m × value of avoided lost units − h/365 × value of extra stock-holding unit-days

- **m** is the gross margin, the profit lost per unit of lost sales.
- **h** is the annual holding-cost rate (capital, storage, waste).

The owner states m and h, for example m = 30% and h = 25% per year. The protocol reports the same results at m ∈ {15%, 30%, 45%} and h ∈ {15%, 25%, 40%} for transparency. Only the owner's chosen pair decides.

**Alternative simple cap:** extra holding unit-days per avoided lost unit ≤ K, with K chosen by the owner (for example K = 30, about one unit held for a month).

## 5. Gates for one cell (segment × level): all must hold

| # | Gate |
|---|---|
| 1 | ≥ 200 series × configuration replays in the cell, and ≥ 30 series |
| 2 | Lost units fall versus D0, and the pooled date-block 95% interval of the reduction is above 0 |
| 3 | Acceptable cost: net benefit > 0 at the owner's (m, h), with the date-block 95% interval above 0; or the cap K is met |
| 4 | **Better than the simple seller rule:** at equal holding unit-days, interpolated on the S(k) curve, the candidate loses no more units than S(k). Otherwise the seller-set safety stock is enough, and AI protection is not promoted. |
| 5 | The result holds at κ = 0.5 and κ = 1.5: the reduction keeps its sign and the net benefit stays positive |
| 6 | Engine parity is exact (§3) |

A pass authorises only an implementation review of an **optional, seller-opted-in protection suggestion** for that cell. It is shown beside the seller's own safety stock and never replaces it.

## 6. Data protection and one-time execution

- **Development (design, checks, rehearsal).** Only products already read: consumed, development_extra and the Stage 3 final holdout, which is now consumed. M5 days up to 2016-05-22.
- **Final.** A new reservation is made **before** any sales are read: 150 never-read M5 products (50 per category) × 10 stores, drawn by a seeded rule from the 2,629 M5 products that no earlier stage has read: not forecast training (53 products), the earlier holdouts, or Stage 3 (consumed, development_extra or holdout). The reservation script re-checks this exclusion. The replay covers the same 182 days for every series, ending 2016-05-22.
- **Execution.** It follows the pattern of F2 and the final package: frozen protocol and hashes, a preflight on the final machine, an `O_EXCL` lock, one execution, `STATUS.json` and a self-verified `SHA256SUMS`.
- **Pakistan.** It is descriptive only, because there is no product-level stock-out or price data.

## 7. Decisions needed before freezing

| # | Decision | Proposed |
|---|---|---|
| Q1 | Margin m and holding rate h (or the cap K) | Owner to state; for example m = 30%, h = 25% per year |
| Q2 | Lead-time and review combinations that matter to the business | {3, 7, 14} × {7, 14} |
| Q3 | Seller-rule grid S(k) | k ∈ {0, 2, 4, 7, 10, 14} days |
| Q4 | Final reservation size | 150 products × 10 stores |
| Q5 | Engine path | Node batch calls to the real engine; a Python port allowed only with exact parity |
