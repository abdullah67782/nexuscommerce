# Inventory AI — Stage 2 report: explainable replenishment

Status: **implemented, uncommitted** in the working tree of `feature/inventory-stage1a` (with Stage 1b). **Resubmitted after review round 2** (§0). Migration 006 is **rehearsed in the cloud copy, not applied on the Windows database.** Design: `docs/inventory-stage2-design.md` (updated with amendments 1–4 and decisions Q1–Q10).

The forecasting models (`nexus-v2-shared-20261008`), the tier/method routing and every file under `ml/` are unchanged; no training was run. No accuracy figure is claimed anywhere.

## 0. Review round 2 — fixes

| Finding | Fix | Regression tests / evidence |
|---|---|---|
| **1. Stock reconciliation warnings were lost.** A −2 movement at exactly the count's timestamp left the Stock tab at "needs review", but replenishment stayed actionable with an unchanged fingerprint, and the old recommendation created a draft. | The input snapshot now carries `stock.reconciliation`: the Stage 1a state (`needs_review` / `none`), the counts of same-instant and count-less movements, and **each ambiguous movement** (id, kind, quantity, source, instant). It is part of the fingerprint. `needs_review` adds the indicative reason `stock_needs_reconciliation` with a warning naming the events: the quantity is marked indicative and no draft is offered. Queue next step: "Check the movements at the count time, or recount." A new count clears it. | Engine: "Review fix 1" test. API: "Review fix 1" — the exact reported sequence (actionable recommendation → −2 damage at the count instant → Stock tab `needs_review`, on-hand unchanged → result indicative, fingerprint changed, event listed → **older recommendation refused 409 `recommendation_stale`**, new one 409 `not_actionable`, no order created → new count makes it actionable again). Browser: screen 15 and `evidence.json` §10. |
| **2. Different sales and stock timezones stayed actionable.** | The forecast input now records the timezones of the product's sales sources (`source_timezones`, part of the fingerprint). If any differs from the stock location's timezone: `needs_information: timezone_mismatch` with an action naming both zones; the combined stock projection (outlooks, shortage before arrival, cover), the quantity and the draft are withheld. Kept and labelled separately: stock facts, incoming orders, supplier terms and the forecast totals with their own dates (`dates_timezone` = the sales timezone; `lag_days: null`, `lag_state: not_comparable`). No conversion is attempted. | Engine: "Review fix 2" (one foreign source is enough; matching zones stay provisional). API: "Review fix 2" — sales source switched to America/Los_Angeles with stock in Asia/Karachi → `needs_information`, facts kept, queue counts it under needs information, **older recommendation refused 409 `recommendation_stale`**, no order. Browser: screens 16–17 and `evidence.json` §11. |
| Alternative-delivery label | "If the overdue and undated deliveries (N unit(s)) **are usable tomorrow**" — matches the calculation (usable on day 2). | Engine label test |

Also fixed while producing the evidence: with the forecast service down, the queue's attention panel said "Nothing needs ordering now"; it now says no outlook can be given and offers Retry (screen 14). The demo setup now confirms the file source's sales up to yesterday, so the evidence reproduces on any day (it ran on 9 October; Pashmina Shawl stays 3 days behind and shows "25 days covered (of 28)").

## 1. What was built

| Part | Files |
|---|---|
| Pure engine, contract `replenishment-1` | `backend/lib/replenishment/engine.js` |
| Explanation templates (no language model) | `backend/lib/replenishment/explain.js` |
| Coherent input snapshot + canonical fingerprint | `backend/lib/replenishment/inputs.js` |
| Shared forecast service (v2 path moved out of the route, unchanged behaviour; cache and concurrency limit for the queue only) | `backend/lib/forecastService.js`, `backend/routes/forecast.js` |
| API: queue, product result, scenario, draft from recommendation | `backend/routes/replenishment.js`, `backend/app.js` |
| Settings: review period (1–28, default 7) and safety stock (≥ 0, default 0) per product and seller default | `backend/routes/inventory.js` |
| Migration 006 (+ down): settings columns, append-only `replenishment_recommendations`, `purchase_orders.source_recommendation_id` with one live order per recommendation | `backend/migrations/006_replenishment*.sql` |
| Sales-upload rollback keeps a product that has logged recommendations | `backend/routes/data.js` |
| Rehearsal also checks purchasing tables (rows, versions, units, events) and setting values | `backend/scripts/rehearse-migration.js` |
| Smoke test for activation (fresh seller, real ML server) | `backend/scripts/smoke-replenishment.js` |
| UI: Replenishment tab (queue), Outlook in the product drawer, scenario panel (not saved), "Create draft order", review/safety settings | `frontend/src/components/inventory/ReplenishmentTab.jsx`, `Outlook.jsx`, `frontend/src/app/inventory/page.jsx`, `frontend/src/styles/workspace.css` (existing colour tokens only) |

## 2. Amendments — how each is met

| Amendment | Implementation | Evidence |
|---|---|---|
| **1** Order quantity respects delivery timing | Daily simulation kept. `raw_need = max(0, −min_k B_k, SS − B_end)` over every day of the window after the order is usable (§3.5), then whole units, MOQ, pack. Shortage before arrival separate. `after_order` projection returned and shown. | Engine tests E1–E4 (first-day / midway / last-day delivery, separate before-arrival shortage), 300 generated cases checked by brute force; screenshot 03 |
| **2** Explicit date coverage | Every outlook returns `start`, `end`, `covered_days`, `complete`, `label`. Lag 3 → 7-day outlook fully covered, 28-day "25 days covered (of 28)". Lag −1 → outlook and quantity withheld with an explicit note; planning date not moved. Lag > 7 → `forecast_too_old`. | Engine R7, lag −1, Q6 tests; API tests "forecast 3 days behind" and "sales confirmed through today"; screenshot 09 ("26 days covered" on the demo) |
| **3** T28 < T7 | Two independent estimates (7-day rate, 28-day rate), warning with both rates, no quantity, no before-arrival figure, `indicative`. | Engine R10 |
| **4** Draft consistency | One REPEATABLE READ, READ ONLY snapshot per computation; canonical SHA-256 over planning date, stock facts, sales since the count, incoming and unplaced orders, supplier terms, settings, forecast input (history fingerprint) and output (release, method, totals) and engine version. Draft: revalidated and created in one transaction under the seller lock; retry returns the existing draft; concurrent requests create one; partial unique index as a second guard. Non-mutation tests compare table **contents** (md5 of all rows). | API tests: idempotent retry, 5 concurrent requests → one draft, stale refusal for a new count, a lead-time change, a safety-stock change and new confirmed sales; non-mutation by contents; smoke test; screenshots 06, 08 |

Decisions Q1–Q10 are applied as listed in design §10. Review round 2 added reconciliation state and source timezones to the inputs and the fingerprint (§0).

## 3. Numerical acceptance results (engine, fixed inputs)

All asserted in `backend/test/replenishment-engine.test.js` (27 tests, pass).

| Case | Result |
|---|---|
| R1 regular | 7 d: demand 28, stock 57; 28 d: demand 120, short 35; cover ≈ 20 d; order usable 2026-10-20, no shortage before; raw 31.86 → 32, MOQ +0, packs +8 → **40** (PKR 112,000); after the order: no shortage in the window, 18.14 at its end, 28-day shortage 0 |
| R2 rare (TSB) | no cover figure; raw 2.14 → **3** |
| R3 insufficient history | `needs_information`, 8 more days needed, no demand, no quantity |
| R4 stale stock | `indicative`, quantity marked indicative, not actionable |
| R5 overdue + undated | excluded; 7-day shortage 6; before arrival 8.19; 15.33 → 16 → **18**; alternative if they are usable tomorrow **0** |
| R6 MOQ / pack | 5 → +19 → 24 → **24**; "19 of the 24 come from the supplier's minimum" |
| R7 lag 3 | `indicative`; 7 d covered 7 (demand 29.14 = forecast days 4–10); 28 d "25 days covered"; raw 33 → 40 indicative; L 14 + R 14 → `horizon_beyond_forecast` (29 > 25) |
| Lag −1 | outlook and quantity withheld, explicit note, planning date unchanged |
| Lag 7 / 8 | 7: indicative, 21 days covered; 8: `forecast_too_old` |
| R8 lead time missing | outlook shown, no quantity, action names the supplier |
| Supplier missing / choice needed | `needs_information` with the right code |
| R9 unknown stock | demand only, stock never treated as 0 |
| R10 T28 < T7 | 7-day estimate 21 (short 1), 28-day estimate 18 (no shortage), no quantity |
| R11 zero demand | no cover figure; 0, or 2 when safety stock exceeds stock |
| R12 approved not sent (+ draft) | quantity unchanged (40), warnings, no further draft offered |
| R13 sales since the count | base 40; scenario from 43: 43.86 → 44 → **50** |
| R14 forecast down | `unavailable`, no forecast numbers, stock and incoming still shown |
| E1 delivery on the window's first day | **0** |
| E2 delivery midway | **2** (old end-of-window rule would give 0); with SS 5 → 5 |
| E3 delivery on the last day | **8**; packs of 6 → 12; SS 5 does not bind |
| E4 shortage before arrival | 10 short before; quantity **14** (window only) |
| E6 minimality | 300 generated cases: `raw_units` passes every daily check, `raw_units − 1` fails |
| Reconciliation needed | `indicative`, quantity indicative only, not actionable, events listed in the reason and warning |
| Timezone mismatch | `needs_information: timezone_mismatch`; no outlook, before-arrival figure or quantity; stock 55, totals 28 / 120 and incoming kept; lag not comparable |

## 4. API tests

`backend/test/replenishment.test.js` (16 tests, pass; the two review-fix tests are described in §0): product result and log dedupe (engine version and history fingerprint inside the logged inputs); queue counts across all products, filters, search, ordering, seller isolation (404 for another seller's product, scenario and recommendation); non-mutation by table contents (and a scenario leaves the log unchanged); scenario labelled, not saved, never actionable; settings per product and seller default with validation; draft from recommendation (draft only, link recorded, retry, unplaced-order block, cancel frees the recommendation, Stage 1b approval still applies); 5 concurrent requests → one draft; stale refusal for four kinds of change with nothing created; not-actionable and mismatched fingerprints refused; lag 3; sales since the count (count-day units ambiguous, 4 units not deducted, scenario from 26); forecast down or switched off (not logged); rollback keeps a product with logged recommendations; lag −1.

`backend/test/upgrade006.test.js` (5 tests): 006 on a database at 005 with stock, settings and a purchase order changes no existing row (content comparison); constraints (ranges, identity, append-only, actionable rule, cross-seller foreign keys, one live order per recommendation, a cancelled order frees it); down refuses with data (including a setting) and works without.

**Totals:** backend **183/183** under `TZ=UTC`, `America/Los_Angeles` and `Asia/Tokyo` (135 before Stage 2; forecast and coverage tests unchanged); ML **23/23**; nothing under `ml/` changed.

## 5. Browser evidence (`docs/evidence/inventory-stage2/`)

Real React pages (bundled with esbuild by the harness — `next build` is not run in the cloud), backend, the real ML server with the frozen release, and PostgreSQL `nexus_demo6` (the Stage 1 demo database + 006, built by `setup_demo6.sh`; run by `e2e_rep.py`; results in `evidence.json`).

| Screen | Shows |
|---|---|
| 01_queue | Attention list, counts, queue with provisional / indicative / needs-information rows and before-arrival shortages |
| 02_filter_short_before_arrival | Filtered queue; counts stay across all products |
| 03_outlook_provisional | Lawn Suit: 70 last-known, shared model, 7 d 36.0 / 28 d 148.1 (77.1 short), cover ≈ 13, order usable 19 Oct, 23.7 → 24 → packs of 10 → **30** (PKR 84,000), after-order outcome |
| 04_outlook_explanation | Numbered explanation and assumptions A1–A4 |
| 05_scenario_not_saved | Review 14 / safety 10 scenario; `evidence.json`: all tables and the log unchanged, settings still default |
| 06_draft_created, 06b_after_draft_no_second_draft | Draft PO for 30 linked to the recommendation; retry returned the same order; no stock movement; reopened: warned, no second draft |
| 07_outlook_overdue_short_before_arrival | Ceramic Mug: overdue PO-5 not counted, ≈ 2.4 short before arrival, alternative if it arrives |
| 08_stale_refused_recomputed | A count recorded while the page was open: draft refused, recomputed result shown, nothing created |
| 09_outlook_indicative_partial_coverage | Pashmina: forecast 2 days behind → indicative, "26 days covered (of 28)", no draft button |
| 10_outlook_needs_information, 11_product_settings_review_safety | Missing supplier with action; review/safety settings |
| 12_queue_mobile, 13_outlook_mobile | 390 px |
| 14_forecast_service_unavailable | ML unreachable: banner, "No outlook for 5 products" attention item with Retry, every row "Forecast unavailable", no figures |
| 15_reconciliation_indicative | Lawn Suit after a −2 damage at the count's instant: indicative, warning naming the event, quantity marked not actionable, no draft button; the older recommendation was refused (409 stale) |
| 16_timezone_mismatch_queue, 17_timezone_mismatch_outlook | Sales source set to America/Los_Angeles (stock in Asia/Karachi): every product needs information; outlook and quantity withheld; stock, incoming and forecast totals (dates in the sales timezone) still shown |

Console: the only entry is the browser's network log of the intended 409 in screen 08.

`smoke_replenishment.txt`: 23/23 against the cloud backend with the real ML server (including the reconciliation and timezone cases). `rehearsal_006.txt`: rehearsal passed on the demo database at 005.

## 6. Judgement calls for review

1. **No second draft while an unplaced order exists.** A draft or approved-not-ordered order for the product is not incoming (R12: suggestion unchanged, warned), and "Create draft" is withheld (`draft_blocked: unplaced_order_exists`) until it is placed or cancelled. Found in browser testing: without it, the recomputed result offered a second draft right after the first.
2. **One live order per recommendation.** The unique index ignores cancelled orders: cancelling a draft lets the same (unchanged) recommendation produce a new one; idempotency keys are numbered.
3. **Alternative quantity** treats overdue and undated deliveries as usable tomorrow; the label now says "are usable tomorrow" (review round 2).
4. **Sales since the count:** sales on feed-covered days without a matching shipment from the same source are counted as not deducted (in the scenario only) and disclosed as unresolved; shipments beyond covered sales are disclosed, not reused.
5. **Stale stock** uses the Stage 1a definition (count age in 24-hour periods vs the tolerance); the count age is part of the fingerprint, so a draft is refused if staleness could have changed.
6. **Forecast cache** (10 minutes, history fingerprint) is used by replenishment only; the forecast route stays uncached. A release change is picked up when entries expire; the release and totals are in the fingerprint.
7. **Not logged:** `unavailable` results, scenarios, and sellers without an inventory location yet (no count or setting ever recorded — never actionable).
8. **Timezones (changed in review round 2):** a sales source in a different timezone from the stock location gives `needs_information: timezone_mismatch` (§0). Zones are compared by IANA name, so two names with identical offsets (e.g. `Asia/Karachi` vs `Etc/GMT-5`) also count as a mismatch — the safe direction. Sources without an import record are taken as the default timezone, as in the forecast route.
9. **Feature switch:** replenishment uses forecast v2, so with `FORECAST_V2_ENABLED` off every result is `unavailable` (stock and orders still shown).
10. **Status precedence:** `needs_information` over `indicative` (e.g. a stale count with no supplier); both reasons are returned.
11. **Draft content:** expected arrival left empty (the supplier's promise is entered when placing it); notes record the recommendation, planning date and engine version.

## 7. Activation on Windows (after review)

1. Stop every running backend.
2. `cd backend` → `node scripts/rehearse-migration.js` → expect `Pending: 006_replenishment` and `REHEARSAL PASSED`.
3. `npm run migrate`, `npm run migrate:status`, `npm start` (with `FORECAST_V2_ENABLED=true`), and start the ML server.
4. `node scripts/smoke-replenishment.js` → expect **23/23**. Besides the draft flow, it checks the two review-round-2 cases on its own test seller: a movement at the count's exact time (indicative, older recommendation refused, a new count resolves it) and a sales-source timezone different from the stock location (needs information, no quantity, older recommendation refused; the timezone is set back afterwards).
5. Frontend: Inventory → Replenishment.
