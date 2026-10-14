# Inventory AI — Stage 3 proposal: demand uncertainty, holiday awareness and AI-assisted safety stock

Status: **revision 2, after architect review.** Development experiments have run (see `docs/inventory-stage3-dev-report.md`); no reserved final outcome has been accessed and nothing is implemented in production.

**Revision 2 changes (Codex review):**
- **Audit wording (§1.1):** the audit *loaded* the excluded data into memory and *excluded it from analysis*; "never read" was inaccurate. The original audit is preserved; the correction is in `stage3_audit/AUDIT_CORRECTION.md`. Guarded loaders now stop reserved data entering development.
- **Categories:** 15 named Pakistan categories plus an uncategorised group (16 groups), not "16 categories plus uncategorised".
- **Eid wording:** "no consistent Eid pattern observed in the inspected US sample", not "no Eid effect".
- **Chronology (§8.2):** research model copies trained before each development period; fitting, calibration and selection periods separate.
- **Protection is measured on the inventory decision (§6.3, §8.4):** order quantities from Stage 2's daily-checkpoint logic, evaluated as "no shortage in the review window after the order is usable"; shortage before arrival separate; L=14/R=14 excluded from the 28-day track.
- **Stockouts (§7.5):** no censoring of every zero or negative ledger day; censor only on supported availability intervals; flag uncertain cases.
- **Targets (§6.3):** 80% and 90% only; 95% needs its own evidence and criterion.
- **Calendar (§3.2):** sellers confirm their country; timezone alone is not used to infer it.
- **Pakistan:** category-level, marketplace-only; target is recorded order quantities (no order status).

Original status line: the only thing executed was a **read-only data audit**: `kaggle_training/stage3_audit/audit_datasets.py`, output in `outputs/audit.json`.
- The forecasting release `nexus-v2-shared-20261008`, its routing rule and the Stage 2 engine `replenishment-1` stay exactly as activated.
- Every Stage 3 capability below is either an experiment to run after approval, or a design to build only if that experiment passes its pre-set criteria.

Contents:
1. Data audit
2. What the data supports now, and what needs more data
3. Store-specific event calendar
4. Event-aware forecasting
5. Insufficient event history: fallbacks and seller scenarios
6. Uncertainty and safety-stock advice
7. Connecting events to replenishment
8. Experiment protocol and promotion criteria
9. API, UI and schema changes (after promotion only)
10. Acceptance criteria
11. Decisions requested

---

## 1. Data audit

### 1.1 Reservation rules applied *before* analysing any sales

The audit was written so that Stage 3 experiments still have untouched evidence. **Correction (revision 2):** the audit script loaded whole files into memory and then *excluded* the reserved parts from every aggregate. "Not read" in the original table meant "loaded but excluded from analysis". No excluded target was aggregated. The guarded loaders in `stage3/data_access.py` now prevent reserved rows or columns from being loaded at all in development.

| Dataset | What the audit analysed | Loaded into memory but excluded from analysis |
|---|---|---|
| M5 | Calendar, catalog columns of all products, and sales of the **180 products already consumed** by earlier work | Sales of the other 2,869 products. They stay available for a fresh product holdout drawn from metadata only. |
| Pakistan e-commerce | Sales from 2016-07-01 to **2017-12-31** | Rows from 2018-01-01 onward; only the latest date (2018-08-28) was reported. |
| Store Item Demand | Ids and dates for all years; sales up to 2016-12-31 | Sales in 2017 |
| UCI Online Retail, Superstore | Everything. The legacy country models already consumed both. | — |

### 1.2 Datasets

| Dataset | Country / timezone | Dates | Size | Product groups | Prior use |
|---|---|---|---|---|---|
| **M5** (Walmart) | USA: 3 states (CA, TX, WI), 10 stores. Store-local dates, no times. | Sales 2011-01-29 → 2016-05-22 (1,941 days). Calendar to 2016-06-19. | 3,049 products, 30,490 store-product series | 3 categories (FOODS 1,437, HOBBIES 565, HOUSEHOLD 1,047), 7 departments | v2 training and both holdouts (§1.4) |
| **Pakistan e-commerce** (Kaggle, converted to the app's import format) | Pakistan. Dates only; Asia/Karachi assumed. | 2016-07-01 → 2018-08-28 | 584,504 order lines, 84,889 products | 15 named categories, plus an uncategorised group (`\N`, 295 products): 16 groups | Demo upload only. Never used to train or evaluate v2. |
| **Store Item Demand** (Kaggle) | Not stated (anonymised; widely regarded as simulated). Timezone unknown. | 2013-01-01 → 2017-12-31 | 10 stores × 50 items | None (item ids only) | Store 10 personalisation experiment (validation 2017-01–06, final 2017-07–12), repeated for stores 1 and 5. Other stores trained that general model through 2016. |
| **UCI Online Retail** | UK (866,317 of 930,329 rows), plus Germany, EIRE, France, Spain and others | 2009-12-01 → 2011-12-09 | 5,252 products | Country is stored in the `category` column | Trained the legacy country models (`ml/models/*.pkl`). No frozen holdout exists. |
| **Superstore** | USA | 2014-01-02 → 2017-12-11 | 3,974 rows, 1,606 products | Office Supplies, Furniture, Technology | Legacy validation |
| `Final_Dataset.csv`, `sample_forecast_data.csv` | — | 2026-02-10 → 2026-05-11 | 625 rows / 510 products; 728 rows / 8 products | — | Re-dated or generated demo files. **Not evidence.** |
| App database (Windows) | Asia/Karachi | — | 16 products, 2,411 sales rows, 9 users (from the 006 rehearsal) | — | Demo and smoke-test sellers. **No real store history yet.** |

The stock columns in UCI and Superstore were derived during an earlier conversion: they count down from 500 per row. They are not observed stock.

### 1.3 Holidays, promotions, closures and stockouts

#### M5

**Events in the calendar:**
- 30 named events: 10 national, 10 religious, 7 cultural, 3 sporting. They include Christmas, New Year, Thanksgiving, Easter, Independence Day, Eid al-Fitr, Eid al-Adha and Ramadan start.
- 650 SNAP (food-assistance payment) days per state.

**Descriptive patterns.** These come only from the 180 consumed products, comparing each event with the mean of days −35 to −8 before it:

| Event | 3-day ratio (event day to +2) | Reading |
|---|---|---|
| Christmas, 2011–2015 | 0.66–0.70 | **Closure:** 0–1 units across all 1,800 store-product series on each 25 December |
| Thanksgiving, 2011–2015 | 0.67–0.82 | Lower sales on the day |
| New Year | pre-week 0.81–0.95, then 0.96–1.13 | Small, mixed |
| Eid al-Fitr / Eid al-Adha, 2011–2015 | 0.80–1.19, no consistent direction | **No consistent Eid pattern observed in the inspected US sample** (180 products; occurrences share dates across series) |

**What is recorded:**
- Promotions: no. There are weekly sell prices only; a price cut could serve as a proxy.
- Closures: no, but Christmas shows them.
- Stockouts: no. A zero cannot be separated from lost sales.

#### Pakistan e-commerce (development period only, to 2017-12-31)

**Volume and sparsity:**
- 424,809 rows and 510,969 units. Every calendar day has sales.
- **Products are extremely sparse.** Of 57,527 products: median 2 selling days; 27,795 sold on only one day; 641 sold on 28 days or more; **11** sold on 180 days or more.
- **Categories are dense:** all 16 groups (15 named + uncategorised) have sales in all 18 months.
- **Target caveat:** with no order status, the series are *recorded order quantities*, not fulfilled demand.

**Promotions:**
- There is no promotion field.
- **21.9%** of rows have revenue below price × quantity, a partial discount proxy.
- Monthly units jump in November: 77,169 in 2016 and 91,700 in 2017, against 9,717–41,879 in the other 16 months.

**Missing from the conversion:** order status (cancelled or refunded), payment method, customer and discount amount. Cancelled orders cannot be excluded from this file.

**Event windows** (total units across the marketplace, compared with days −35 to −8 before each event; Pakistani dates are approximate and still need local confirmation):

| Event (approximate date) | Pre-week | Event 3 days | Post-week | Reading |
|---|---|---|---|---|
| Black/White Friday 2016 (25 Nov) | 11.96 | **17.74** | 2.05 | Marketplace-wide sale campaign: a commercial event, not a holiday |
| Black/White Friday 2017 (24 Nov) | 11.84 | **14.14** | 2.01 | Same |
| Eid al-Fitr 2017 (≈26 Jun) | 0.53 | **0.14** | 0.39 | Online sales **fall** around Eid |
| Eid al-Adha 2016 (≈13 Sep) / 2017 (≈2 Sep) | 0.84 / 0.38 | 0.35 / 0.27 | 0.79 / 0.27 | Falls. September 2017 was the lowest month (9,717 units). |
| Ramadan start 2017 (≈27 May) | 1.53 | 0.45 | 0.42 | Confounded by the April–May sales level |
| Independence Day 2017 (14 Aug) | 2.21 | 1.80 | 0.64 | Rise, probably a sale campaign |
| Pakistan Day 2017 (23 Mar) | 1.17 | 2.38 | 1.07 | Rise |
| Christmas / Quaid Day 2016 and 2017 | 0.18 / 0.22 | 0.18 / 0.12 | 0.22 / 0.09 | **Not interpretable:** the baseline window contains White Friday |

These are marketplace-wide aggregates from a single business, with cancellations included. They show **direction and confounding**, not effect sizes for a store.

**What is recorded:**
- Closures: no.
- Stockouts: no. It is a marketplace with no stock data.

**Reserved (loaded by the original audit but excluded from analysis; development now uses an extract that never contains it):** 2018-01-01 to 2018-08-28. That period contains New Year 2018, Ramadan 2018, Eid al-Fitr 2018 (≈16 Jun), Independence Day 2018 and Eid al-Adha 2018 (≈22 Aug). It contains **no** White Friday.

#### UCI Online Retail

- No sales from 24 December to 3 January in both 2009/10 and 2010/11: a holiday closure.
- Pre-Christmas activity is in the data.
- There is no promotion or stock field.

#### Store Item Demand

- No missing days and no zero-sale rows.
- Normal sales on Christmas Day (15,351–25,195 units).
- Consistent with simulated data. There are no events or groups to learn from.

### 1.4 Data already consumed (must not be presented as untouched evidence)

| Evidence | Products / series | Periods | Status |
|---|---|---|---|
| M5 development and sample candidates | 60 products, including the 53 v2 training products | Every day to 2016-05-22: training to 2015-05-31, validation 2015-06–11, final 2015-12-01 to 2016-05-22 | **Consumed.** Development use only. |
| M5 first reserved holdout | 60 products × CA_1, TX_1, WI_1 | Origins 2015-12-01 to 2016-05-10 | **Consumed** |
| M5 production holdout `nexus-production-holdout-20261008-v1` | 60 products × 10 stores | 2015-12-01 to 2016-05-16 | **Consumed** |
| Store Item Demand | Stores 1, 5, 10 in 2017; all stores to 2016 | — | **Consumed** |
| UCI, Superstore | All | All | Consumed by the legacy models |
| Pakistan, 2016-07 to 2017-12 | Aggregates read by this audit | — | **Development only from now on** |
| **Unused** | **M5: 2,869 products. Pakistan: 2018-01-01 to 2018-08-28. Store Item Demand: 2017 for stores 2–4 and 6–9.** | — | Available for fresh reservations |

One caution on M5: 2015-12 to 2016-05 has already been *seen* through other products. A fresh-product holdout in that period tests unseen products, not an unseen period.

---

## 2. What the data supports now, and what needs more data

| Capability | Supported now | Needs more data |
|---|---|---|
| Event features for US holidays and closures (Christmas, Thanksgiving, New Year, Easter, SNAP) | **Yes, M5.** 5 occurrences each, 1,800+ series. A fresh product holdout is possible. | — |
| Eid / Ramadan effects | **Partly.** Pakistan e-commerce at **category level, this marketplace only** (no SKU advice, no general Pakistan-store effect): 1–2 development occurrences per event, 1 reserved occurrence each. No consistent Eid pattern was observed in the inspected US sample, so US evidence **does not transfer**. | Physical-store sales in Pakistan, ideally ≥2 confirmed seasons per store; order status, to exclude cancellations |
| Product-level holiday effects | **No.** Pakistan products are too sparse (11 have ≥180 selling days). | Store histories with regular sellers |
| Commercial events (White Friday, sales) | Development evidence only (2 occurrences). **None in the reserved period**, so nothing can be claimed. | Recorded promotions with dates, scope and discount |
| Seller promotions as an input | No historical promotion field anywhere. The 21.9% discount proxy is not a promotion calendar. | Promotions entered by sellers (§3) and recorded going forward |
| Store closures | M5 Christmas and UCI late-December show closures exist | Seller-entered closures (§3) |
| Uncertainty for totals (regular / occasional / rare / short history) | **Yes, M5 fresh products.** Short history can be simulated by truncating series. Pakistan category series as a second market. | Real store histories to check calibration in this app's market |
| Daily demand paths | Daily actuals exist in M5 and Pakistan, so daily models can be *tested* | — |
| Stockout-censored demand | **No dataset records stockouts.** A correction cannot be validated, only flagged heuristically. | The Stage 1 ledger (counts and movements) accumulating per seller |
| Supplier delays | No historical data | Stage 1b order history (`ordered_at`, promised dates, receipts) accumulating |

---

## 3. Store-specific event calendar

The calendar is a **data layer**, independent of any model. It is useful even before any event effect is learned: for display, closures, supplier delays and seller scenarios.

### 3.1 Model

| Table (migration 007, proposed) | Purpose |
|---|---|
| `calendar_event_catalog` | System events per country: key (`eid_al_fitr`), name, type (`religious` / `national` / `commercial` / `cultural`), recurrence (`fixed` such as 14 Aug; `rule` such as Thanksgiving; `lunar`, for Eid, Ramadan and Muharram) |
| `calendar_event_dates` | One row per country, event and year: `date_start`, `date_end`, `status` (`expected` / `confirmed` / `cancelled`), `source` (`official_notification`, `astronomical_estimate`, `seller`), `confirmed_at`, `confirmed_by`, `calendar_version`. **Append-only**: a correction adds a new version. |
| `seller_calendar` | Country (default from the location's timezone, editable), subscribed event types, and **local date overrides** (the seller confirms "Eid al-Fitr is 16 June here"). Overrides apply to that seller only. |
| `seller_events` | Seller-entered `promotion`, `closure`, `supplier_delay` and `other` entries: start and end as business dates in the location's timezone, scope (all products / category / listed products / supplier), optional discount %, extra delay days for supplier delays, and notes. Revisions are append-only. Cancelling keeps history. |

### 3.2 Maintaining dates

- **Fixed and rule-based holidays** are generated for the next two years from catalog rules. A yearly review step compares them with the official public-holiday notification and records the source. They are `confirmed` only after that check.
- **Islamic (lunar) events** are generated as `expected` from an astronomical estimate, with a **±1-day uncertainty window**, because the local date depends on moon sighting.
  - They become `confirmed` when an administrator records the official national announcement, or the seller confirms a local date.
  - Until confirmed, features and displays use the window, labelled "expected, not yet confirmed".
- **Version recorded.** Every forecast or recommendation records the calendar version it used. The version is part of the Stage 2 input fingerprint, so a date change invalidates older recommendations: the Stage 2 "stale" rule, reused.
- **Timezone.** Events are business dates in the stock location's timezone, so the Stage 2 timezone-mismatch rule still applies. No conversion is attempted.
- **Country (revision 2).** The seller **confirms their country**; the timezone only pre-fills a suggestion, because a timezone does not identify a country reliably. Until confirmed, no country-specific event effect is used.
- **Historical experiments** use only the event information available at each origin (lunar dates as the ±1-day window until the day before the event).

---

## 4. Event-aware forecasting

### 4.1 Principle: learn effects from evidence, never apply a universal multiplier

The audit shows why:
- Christmas: closure in US stores.
- Eid: no consistent pattern in the inspected US sample, but a fall in recorded orders on one Pakistani marketplace.
- White Friday: about 15× on the Pakistani marketplace.

The same holiday name means different things in different markets and channels. Effects are therefore estimated **per market (country × channel) and per product group**, then adapted to the store.

### 4.2 Two candidate designs (both to be tested; the frozen release stays the comparator)

**Design E1 — event layer on top of the frozen model (preferred first).**
- The frozen v2 totals are unchanged.
- A separate, small model learns a **multiplicative adjustment** for horizons that overlap event windows:
  `adjusted_total = frozen_total × exp(Σ effect(event_type, offset_bucket, product_group))`.
- Effects are estimated as log-ratios of actual totals to frozen-model forecasts on past windows that overlap events, so the layer learns only what the frozen model misses.
- Offset buckets: −14..−8, −7..−1, 0, +1..+3, +4..+7 days.
- **Exposure features for totals:** for a 7- or 28-day horizon, the number of horizon days in each offset bucket of each event type, the number of closure days, and seller-promotion days with discount.
- Advantages: the frozen model is untouched; the layer is auditable; with no events in the horizon it returns exactly the frozen forecast.

**Design E2 — daily event-aware model (research track).**
- A daily, direct multi-horizon model with event features: days to and from each event type (capped at ±14), event type, product group, closure flag and promotion flag.
- It produces daily paths, which also serve §6.
- Larger change; would need its own fresh holdout.

### 4.3 Adapting general patterns to a store's own history

Each effect is estimated at three levels and combined by **shrinkage**:

- `effect_store = (n_s · ê_store + k · ê_group) / (n_s + k)`, where:
  - `n_s` is the number of **confirmed past occurrences** of that event in the store, with confirmed coverage around them;
  - `ê_group` is the market × product-group estimate.
- `k` (prior strength) is chosen on validation data only.

As a store accumulates seasons, its own evidence takes over. With none, it uses the general pattern for its market and group, but only if that pattern passed the experiment for that market (§8). This mirrors the personalisation research already done, adaptation on top of a pooled model, now applied to event effects.

Products are mapped to groups through the existing product category. Groups need a minimum size; small groups are pooled into "other".

---

## 5. Insufficient event history: fallbacks and seller scenarios

Every number carries one of four labels:

| Label | When | Shown as |
|---|---|---|
| `learned_store` | ≥2 confirmed past occurrences in this store, **and** the store-level layer passed evaluation | "Based on your last N <event>s" |
| `learned_general` | Fewer store occurrences, but the market × group effect passed the experiment for this market | "General pattern for <group> in <market>, not yet your own history" |
| `assumed_by_seller` | The seller enters a scenario ("+40% for Lawn Suits, 10–20 June") | "Your assumption: +40%", never presented as a prediction. Not saved into forecasts; a saved scenario is stored as a seller event. |
| `none` | No validated effect, or the event date is unconfirmed beyond its window | The frozen forecast unchanged, plus the note "<event> in the period; its effect on your sales is not known" |

Rules:
- An unconfirmed lunar date never produces a learned adjustment on a single day. It uses the ±1-day window, or `none`.
- Promotions entered by the seller are `assumed_by_seller` until the store has ≥2 past promotions with recorded scope and discount *and* the layer is validated on them.
- Percentage scenarios and learned effects are **never combined silently**. A seller scenario replaces the learned adjustment for that window, and the result says so.

---

## 6. Uncertainty and safety-stock advice

### 6.1 The limitation, stated first

v2 returns two **totals**: days 1–7 and days 1–28. It gives no daily paths and no quantiles.

The Stage 2 engine needs demand over arbitrary windows: lead time, then the review window. That is why it currently uses even spreading (A1) and seller-set safety stock.

Quantiles of a 7- or 28-day total **do not** give quantiles for, say, days 9–15. Scaling them with √days or by proportion is an unvalidated assumption, and this proposal does not adopt it.

### 6.2 Candidate methods (compared, none assumed better)

| ID | Method | Output |
|---|---|---|
| U0 | **Historical-error baseline:** the product's own rolling-origin errors of the frozen forecast (actual ÷ forecast over past 7/28-day windows), with empirical quantiles. Short history is pooled by sales pattern. | Quantiles of 7- and 28-day totals |
| U1 | **Conformal prediction** on the frozen totals: normalised scores, Mondrian by pattern group × event-window flag, rolling calibration window, plus adaptive conformal updating for drift | Intervals with a marginal coverage target, under stated assumptions |
| U2 | **Quantile gradient boosting** on the same features (P50/P80/P90), conformalised (CQR) | Quantiles of totals |
| U3 | **Rare products:** a bootstrap of the TSB demand process (occurrence probability × size) | Distribution of the total, including P(0) |
| P1 | **Daily paths by shape bootstrap:** resample the product's own recent daily profile (by weekday and event offset), scaled to sampled totals | Paths consistent with each total, for **any window** |
| P2 | **Daily model from Design E2,** with quantile or distributional outputs | Paths and window quantiles |

P1 and P2 are what would let the engine get **window-specific** quantiles: demand over days `a..a+R−1`, and before arrival. They are evaluated directly on those windows (§8), not assumed.

### 6.3 Safety-stock advice

- **Protection window:** lead time + 1 + review period, exactly the Stage 2 window.
- **Suggested safety stock (revision 2):** measured on the decision itself. For each sampled daily demand path the Stage 2 daily-checkpoint quantity is computed; the suggestion is the p-quantile of those quantities minus the point-forecast quantity, for a seller-chosen target `p` of **80% or 90%**. 95% is not offered until it has its own evidence and criterion.
- **Protection measured** as the share of past decisions with no shortage in the review window after the order became usable. Shortage before arrival is reported separately, because an order placed today cannot prevent it.
- **Shown only where the method passed calibration for that segment** (regular / occasional / rare / short history, event window or not). Otherwise: "No suggestion: past coverage for this kind of product was not reliable".
- The display shows "In past test periods, demand stayed within this level in X% of windows for similar products". It is historical, segment-level, and **never** a promise or a "confidence".
- **AI-assisted, seller-approved:** "Use as my safety stock" saves the Stage 2 `safety_stock_units` setting with provenance `suggested:<method version>`. Nothing is applied automatically. A suggestion is recomputed and flagged when it drifts from the saved value.
- **Supplier lead-time variability** joins later, once Stage 1b records hold enough completed orders per supplier (proposed: ≥8). Open late orders count as censored, not dropped.

---

## 7. Connecting events to replenishment

These are changes to the Stage 2 engine. They would ship as `replenishment-2` only after promotion; `replenishment-1` behaviour remains the default.

1. **Demand over windows.** The engine already consumes "cumulative demand over a day range".
   - With E1, the event adjustment is allocated to the days in each event window (allocation A1e: even within the window, labelled).
   - With P1/P2, it uses daily paths directly.
   - Seller scenarios add `assumed_by_seller` uplift over their dates.
2. **Closures.** Closed days have zero sales, and deliveries due on a closed day become usable on the next open day (extends A2).
3. **Supplier delays.**
   - A `supplier_delay` event adds its days to the lead time of orders whose expected arrival falls inside it.
   - The result shows "lead time 10 + 5 (supplier delay 1–10 June)".
   - Open orders with dates inside the delay are not shifted silently; they get a warning.
4. **Order timing.** A new output, "order by":
   - It is the latest planning day on which an order still becomes usable before the first projected shortage in an event-heavy window.
   - Example: "Order by 2 June so it is usable before the Eid window".
   - It is deterministic and derived from the same projection, not a new prediction.
5. **Stockout-suppressed history (revision 2).**
   - Days are **censored only inside supported availability intervals**: a recorded count of zero followed by a receipt, with no sales in between, or an explicit seller-marked out-of-stock period. Negative ledger stock means the records are inconsistent, and a last-known zero is not enough, so such days are **flagged as uncertain**, not censored.
   - Before ledger data exists, a heuristic flags suspicious zero runs, for example a regular seller (≥80% selling days) with ≥3 consecutive zeros outside closures.
   - Flagged days are **reported, not imputed**, by default. The experiments compare "exclude" with "keep as zero" in development only. Imputing lost demand is not proposed: nothing could validate it.
   - Simulated outcomes using observed sales as demand are **lower bounds** wherever stockouts are unknown, and the report says so.

Calendar version, seller events in scope and the uncertainty method version all join the Stage 2 fingerprint.

---

## 8. Experiment protocol and promotion criteria

### 8.1 General rules (as in v2)

- Reservations are made **from metadata only**, before any sales in them are read.
- The protocol (windows, metrics, comparisons, thresholds, code hashes) is **frozen before** reserved data is read.
- Each final evaluation runs **once**, through the application's own code, and every result is kept, including losses.
- Tuning and selection use development and validation data only.
- **Comparator:** the frozen release `nexus-v2-shared-20261008` as served (rule + TSB), plus the 28-day-average baseline.

### 8.2 Experiment E-US (M5)

- **New reservation `nexus-stage3-m5-holdout-v1`:** 90 products (30 per category), seeded and metadata-only, from the 2,869 unused products; eligible if first priced at least 180 days before the training cutoff.
- **Development products:** the 180 consumed products, plus a seeded development sample of 150 further unused products, drawn and recorded before reservation so the two sets are disjoint.
- **Periods (revision 2 chronology):**
  - research model copies R12 / R13 / R14 (frozen recipe, cutoffs 2012-05-31 / 2013-05-31 / 2014-05-31; every training target window ends before its cutoff) serve FIT_A (2012-06..2013-05), FIT_B (2013-06..2014-05), CAL (2014-06..10) and SEL (2014-11..2015-05);
  - **final calibration** 2015-06-01 → 2015-10-31 with the frozen release on development products;
  - **final** 2015-11-01 → 2016-05-22 on the reserved products only, with the frozen release as comparator: Thanksgiving 2015, Christmas 2015, New Year 2016, Easter 2016.
  - This period was seen through other products; that is disclosed.
- **Tests:** E1 (event layer), U0–U3, P1, P2 and E2 at the research stage, and the replenishment simulation.

### 8.3 Experiment E-PK (Pakistan e-commerce)

- **Units:**
  - **15 named-category daily series** (the primary unit; the uncategorised group reported separately), as recorded order quantities;
  - products with ≥28 selling days by 2017-12-31 (**641**, chosen from development history only), reported separately and descriptively.
- **Periods:**
  - fit 2016-07-01 → 2017-06-30;
  - **validation** 2017-07-01 → 2017-12-31: Independence Day, Eid al-Adha 2017, White Friday 2017;
  - refit to 2017-12-31;
  - **final** 2018-01-01 → 2018-08-28, **reserved, outcomes not analysed**: Ramadan, Eid al-Fitr 2018, Independence Day, Eid al-Adha 2018.
- **What it can claim:** within-market evidence for religious and national events, at category level, for one online marketplace, with cancellations included. It cannot claim anything about commercial events, because none fall in the final period, or about physical stores.
- **Bonus:** it is also the first out-of-country check of the **frozen** v2 model, which was never evaluated on Pakistani data.
- **Event dates** are confirmed from official notifications and frozen **before** the final run.

### 8.4 Metrics, reported per market, horizon and segment

| Area | Metrics |
|---|---|
| Point forecasts | WAPE and bias overall. **Event-window WAPE and bias** (horizons overlapping an event ±7 days) separately. Non-event windows separately, to show no harm. |
| Segments | Regular / occasional / rare / dormant (the existing past-only groups), and **short history**: series truncated to 28–179 days of past at each origin |
| Uncertainty | Empirical coverage at nominal 80/90%; interval width relative to the mean; pinball loss. Overall, by segment, and in event windows. Window-level coverage for the Stage 2 windows (lead time + 1 + review, for L ∈ {3, 7, 14}, R ∈ {7, 14}) — the check §6.1 requires. |
| Decision protection (revision 2) | For each origin and (L, R) ∈ {(3,7), (7,7), (3,14), (7,14), (14,7)} (L14/R14 excluded: 29 days > 28): the Stage 2 quantity from each method; success = no shortage in the review window after the order is usable; shortage before arrival separate; lost units, end stock and mean quantity versus safety stock 0. Starting stock κ × point demand (κ = 1; 0.5 and 1.5 as sensitivity), with and without an existing mid-window delivery. Shortage is a **lower bound** where stockouts are unknown. |

### 8.5 Promotion criteria (fixed now, applied once to the final run)

A capability is promoted only if **all** its criteria hold on the final data. Otherwise production keeps the Stage 2 behaviour and the result is reported as it is.

| Capability | Criteria |
|---|---|
| **Event layer (E1), per market** | (a) Event-window WAPE improves by ≥5% relative to the frozen release, at both horizons. (b) Non-event and overall WAPE are no worse than the frozen release + 0.5 points. (c) Event-window bias does not grow in absolute value. (d) A product- (or category-) level bootstrap interval of the event-window improvement excludes zero. This is descriptive, not a guarantee. |
| **Uncertainty method, per segment** | Coverage (share of windows with actual ≤ the upper quantile) at nominal 80% and 90% within ±5 points (±10 for rare) in **both** event and non-event windows, with ≥200 windows and ≥30 series, and dependence-aware (date-block) intervals. Narrower than U0 at equal or better coverage, or U0 itself if nothing beats it. A segment that fails gets no suggestion. |
| **Safety-stock suggestion (revision 2)** | Decision coverage within ±5 points (±10 rare) of the target on every (L, R) pair tested; the trade-off against safety stock 0 (lost units, end stock, quantity) is reported. Occurrence counts and date-block intervals reported; passing authorises a suggestion only for the evaluated scope. |
| **Daily paths (P1/P2)** | Window coverage criterion above, **plus** daily-allocation error ≤ that of A1 even spreading within windows |

No accuracy or confidence figure appears in the app as a result. The app shows only the labelled, segment-level historical coverage of §6.3.

---

## 9. API, UI and schema changes (only after promotion)

**Unchanged until then:** `/api/forecast/v2/*`, `/api/inventory/replenishment*` and the stored `replenishment-1` recommendations.

| Area | Change |
|---|---|
| Migration 007 | The calendar tables of §3.1; `inventory_policies.safety_stock_provenance` (`seller` / `suggested:<method>`); a recommendation log entry for engine `replenishment-2`. Down migration refuses when data exists. Rehearsal checks extended. |
| Calendar API | `GET /api/calendar?from&to` (merged system and seller events, with status and version); `POST/PATCH /api/calendar/events` (promotion, closure, supplier delay); `POST /api/calendar/dates/:id/confirm` (local date); `GET/PATCH /api/calendar/settings` (country, subscriptions) |
| Forecast v2 response | Add `events_in_horizon[]` and `event_adjustment {label: learned_store / learned_general / assumed_by_seller / none, effect, basis}`. Only for promoted markets. |
| Replenishment | Outlook lists events in the window. The scenario accepts `demand_scenarios[{start, end, percent, scope}]`, labelled `assumed_by_seller`. Adds `order_by` and closure / supplier-delay notes. `safety_stock_suggestion {units, target, method, segment, historical_coverage, label}` with "Use as my safety stock". |
| UI | A Calendar view (Inventory → Calendar): confirm Eid dates, add promotions, closures and supplier delays. Event chips and labels on the Outlook. A safety-stock suggestion card. Wording checks: no "confidence", "accuracy", "guaranteed" or "95%". Existing colours only. |

---

## 10. Acceptance criteria (for the later implementation phase)

1. With no events and no promoted method, every forecast and replenishment output is **identical** to today's (regression test against stored `replenishment-1` results).
2. The calendar is append-only with versions. A date confirmation or seller event changes the fingerprint, and older recommendations are refused as stale (Stage 2 test pattern).
3. Unconfirmed lunar dates never drive a single-day adjustment. Labels always match §5.
4. Seller scenarios are labelled, never stored as learned effects, and never combined silently.
5. Closures and supplier delays change usable-day and lead-time arithmetic exactly as specified, with numerical tests (Stage 2 style, including early, midway and last-day cases).
6. Safety-stock suggestions appear only for segments that passed, carry their method version, and require the seller's action.
7. Experiment scripts refuse to rerun or run out of order. Reservations and protocols carry hashes. The final runs execute once and every outcome is reported.
8. The models of `nexus-v2-shared-20261008` keep their hashes. Any promoted event layer or uncertainty method has its own manifest and version.

---

## 11. Decisions requested

| # | Question | Proposal |
|---|---|---|
| Q1 | Experiment markets | E-US (M5) and E-PK (category level), as in §8. Store Item Demand only as a mechanics check, never as evidence. |
| Q2 | First event design | E1 (layer on the frozen model) first; E2 / P2 as a research track |
| Q3 | Reservation sizes | M5: 90 fresh products (30 per category) and 150 further development products. Pakistan: the final period 2018-01-01 → 2018-08-28. |
| Q4 | Promotion thresholds | As in §8.5 (≥5% event-window gain, ≤0.5-point overall loss, coverage ±5 / ±10 points) |
| Q5 | Shrinkage evidence threshold | `learned_store` needs ≥2 confirmed occurrences; `k` tuned on validation |
| Q6 | Stockout handling | **Decided:** flagging approved; censor only on supported availability evidence; no imputation |
| Q7 | Calendar maintenance | Official-source yearly review for fixed holidays. Lunar events `expected` (±1 day) until confirmed by an administrator or the seller. |
| Q8 | Safety-stock targets offered | **Decided:** 80% and 90%; 95% only after its own evidence and criterion |
| Q9 | Order of work after approval | (1) Freeze the reservations and protocol; (2) development runs; (3) a short report for review; (4) the frozen final runs; (5) implement only what passed |
