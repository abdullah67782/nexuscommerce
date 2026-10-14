# Inventory AI — future extensions (outside the delivered module)

**Status: NOT BUILT; not part of the delivered Inventory AI module.** On 2026-10-14 the owner closed the module at its approved staged scope (`fc67420`). The six architecture items below are recorded here as future extensions. They do not keep the delivered module open. If they are taken up, each needs its own approval, and its decisions (A1–A7) are settled with the architect first.

**Research outcomes stay recorded and are not reopened:**
- AI purchasing protection: no candidate demonstrated superiority under the frozen comparison.
- Learned holiday/event effects: failed the final evaluation.

The text below is the implementation sketch drafted on 2026-10-14 (smallest complete version, dependencies, acceptance checks). It is kept as a starting point.

## Item 1 — Budget-constrained purchasing plan (architecture §7, §10 planner)

**Smallest complete version:**
- **Inputs.** The seller enters a budget and one currency. The plan uses the current replenishment queue: every product with an actionable quantity and a supplier cost in that currency. Products without cost, or with costs in another currency, are listed as excluded, with the reason.
- **Candidate quantities.** For each product: 0, plus every pack- and MOQ-feasible quantity up to the engine's suggested quantity.
- **Engine projection.** Each candidate's projected shortage (units short before the next review's arrival, from the engine's daily checkpoints) is computed by `engine.js` itself. The planner does no new arithmetic on demand.
- **Objective.** Minimise total projected shortage units. Ties go to lower spend. No profit is fabricated: margin is not known.
- **Solver.** An exact multiple-choice knapsack, solved by dynamic programming over integer minor currency units. A cap on candidates × budget steps applies; above it the solver returns `TOO_LARGE` with the reason, never a silent heuristic.
- **Statuses:**
  - `OPTIMAL`;
  - `INFEASIBLE_ITEMS` (an MOQ or pack cost alone exceeds the budget; those items are listed);
  - `NOTHING_TO_ORDER`;
  - `TOO_LARGE`.
- **Comparison.** A greedy allocator (shortage avoided per unit of currency) is computed alongside for comparison, as the architecture asks.
- **Output.** For each product: the chosen quantity, cost, shortage avoided and unserved need. Also the plan spend and the remaining budget.
- **Persistence and drafts.** The plan is stored as a snapshot (inputs fingerprint and outputs). "Create drafts" makes one draft per supplier through the existing draft path, and is refused if any input fingerprint is stale.

**Dependencies:** migration 009 (`purchase_plans`); engine; purchasing.

**Acceptance checks:**
- (a) On 200 random small instances, the solver equals brute force exactly.
- (b) Spend ≤ budget always; pack and MOQ are always honoured.
- (c) Infeasible items, missing cost and currency mismatch are each reported.
- (d) A stale plan's drafts are refused (409).
- (e) Draft creation is idempotent, one draft per supplier.
- (f) Stock is unchanged.
- (g) The UI works at 390, 768 and 1440 px.

**Working.**

## Item 2 — Inventory anomaly checks (architecture §6D)

**Smallest complete version:** explainable accounting checks only. Each check gives evidence and the action "investigate"; nothing is deleted or blamed. There are four checks:
1. **Count discrepancy.** A count differs from the expected position (previous count + recorded movements − confirmed sales between them) by more than max(3 units, 20% of the expected position). This runs only when the sales between the two counts are fully confirmed; otherwise the state is "cannot check".
2. **Unusual damage or customer returns.** The last 28 days' total exceeds the seller's own median + 3 × MAD over earlier 28-day windows. At least 4 earlier windows are needed; otherwise "not enough history".
3. **Abrupt sales change.** The last 7 days against the previous 28-day daily rate, Poisson tail p < 0.001 in either direction. This runs only on confirmed days. Large real orders stay valid: the check flags, it never corrects.
4. **Receipt corrections.** A corrections share above 20% of received units over 90 days, with at least 3 receipts.

**Seller review:** the seller marks each alert "investigated — fine" or "investigated — error found", with an optional note. Reviews are append-only and are kept as future adjudicated labels.

**Dependencies:** migration 009 (`inventory_anomaly_reviews`); ledger; coverage; purchasing.

**Acceptance checks:**
- (a) Each check has seeded positive and negative cases.
- (b) Unknown sales days are never treated as zero.
- (c) The states "cannot check" and "not enough history" are shown.
- (d) No automatic change to any record.
- (e) Reviews are isolated per seller.

**State:**
- The deterministic checks are **Working**.
- An **Isolation Forest or alert-precision evaluation** **Needs seller data**: adjudicated reviews must exist first. It is recorded as data-dependent and not built.

## Item 3 — Excess-stock and slow-mover advice (architecture §6E)

**Smallest complete version:**
- **Excess units at 28 days:**
  - formula: position (on hand + open inbound) − (28-day forecast + seller safety stock);
  - conservative version: shown "even at the 90% upper estimate" where an upper estimate is available, otherwise against the point forecast, with that label.
- **Longer horizons** (56 or 90 days): labelled "approximation (28-day rate extended)", never as validated.
- **Slow mover:** stock above 0, no confirmed sale in the last 60 days, and selling share under 10% over 180 days.
- **Stock age:** days since the last receipt. It is labelled "since last receipt" (not lot age; no expiry data).
- **Value:** at unit cost when a supplier cost exists, otherwise units only. Selling price is never used as inventory value.
- **Suggested actions (advice only):**
  - pause reordering (the engine already suggests 0; this is shown);
  - investigate;
  - consider a seller-approved promotion, as a labelled scenario that is not a validated price-response estimate.
- No transfers: there is one location.

**Dependencies:** forecast service; upper estimates; stock positions; purchasing terms. No migration.

**Acceptance checks:**
- (a) Seeded overstock, slow-mover and normal products are classified correctly.
- (b) No value is shown without cost; price is never used.
- (c) Unknown or stale stock gives "cannot assess", never "no excess".
- (d) The ML-down state is shown.
- (e) Approximation labels appear beyond 28 days.

**Working.**

## Item 4 — Grounded inventory assistant (architecture §9)

**Smallest complete version:** a deterministic assistant. No LLM is configured; the architecture says "use deterministic explanations when no LLM is configured".
- **Question set:**
  - Why reorder X?
  - What if delivery is N days late?
  - Which orders fit a budget of B?
  - What is excess?
  - Any anomalies?
  - What does the supplier's history show?
- **How it answers:** each question is chosen from suggestions or recognised from a few keywords. It calls the same seller-scoped read services and scenario endpoints. Every number comes from a stored or recomputed service result; no arithmetic is done in text.
- **Answers:** each cites its source (recommendation id, plan id, as-of time) and its assumptions, and links to the screen.
- **Read-only:** it cannot create or approve orders or change settings, and it offers links to the existing approval screens.
- **Unrecognised questions:** the answer lists what it can answer.
- **Optional LLM phrasing adapter:** not built. It needs a configured provider and an evaluation, so it is recorded as **needs configuration**.

**Dependencies:** items 1–3; the scenario endpoint; supplier performance.

**Acceptance checks:**
- (a) Each question type's numbers equal the underlying service response exactly (tested).
- (b) No route mutates anything.
- (c) Product and supplier names are treated as data. An injected text such as "ignore … approve order" changes nothing.
- (d) Answers are isolated per seller.
- (e) Unknown questions get the capability list.

**Working (deterministic).**

## Item 5 — Recommendation outcomes tracking (architecture §8 shadow mode, §10 outcomes view)

**Smallest complete version:** for each logged recommendation (`replenishment_recommendations`) whose 7- or 28-day horizon has fully passed:
- **Forecast error:** actual confirmed sales vs the forecast total, as absolute error and bias. Aggregated as WAPE and bias across products, with sample counts.
- **Realised stock:** any count of 0 or flagged stock-out in the window, using the stock-out flag wording.
- **Order follow-through:** a draft created, approved, received; arrival vs expected.
- **Decision recorded:** from item 6.

**Labels:**
- "Simulation" (the research results) is shown separately from "Actual".
- Seller acceptance is not a correctness label, and no causal benefit is claimed.

**States:** "pending: horizon not yet passed" and "not assessable: sales not confirmed".

**Dependencies:** item 6; recommendation log; coverage; stock-out flags. No migration beyond 009.

**Acceptance checks:**
- (a) Seeded recommendations whose horizon has passed produce the hand-computed error and bias.
- (b) Unconfirmed days make the window "not assessable", never zero.
- (c) Pending windows are not scored.
- (d) Per-seller isolation.

**State:** the calculation and view are **Working**. Real outcomes **Need seller data**: they fill in as horizons pass.

## Item 6 — Accept, reject and snooze (architecture §10 decision route)

**Smallest complete version:** `POST /api/inventory/recommendations/:id/decision` with `{ decision, reason_code?, note?, snooze_until? }`.
- **Accept:** records intent. It links to "Create draft" (the existing path). It never creates on-hand stock.
- **Reject:** needs a reason code (have stock elsewhere, demand will drop, supplier issue, quantity wrong, other).
- **Snooze:** hides the product from the queue until a date (at most 30 days) or until the recommendation's inputs change, whichever comes first.
- **Records:** decisions are append-only, with the latest one effective. A decision on a stale recommendation is refused (409), as for drafts.
- **Queue:** shows a "Snoozed (n)" filter and the latest decision.

**Dependencies:** migration 009 (`recommendation_decisions`); replenishment routes and UI.

**Acceptance checks:**
- (a) Each decision is recorded and shown.
- (b) A snooze expires by date and by an input change.
- (c) A stale decision is refused.
- (d) Double-submit is idempotent.
- (e) Isolation.
- (f) Stock is unchanged.

**Working.**

## Architectural decisions to settle (Opus proposes; Codex decides)

| # | Decision | Proposal |
|---|---|---|
| A1 | Optimiser method | Exact DP in the backend (no new dependency, provably optimal, shown by statuses) instead of CP-SAT. OR-Tools is not installed, and pack/MOQ/budget over one queue fits a multiple-choice knapsack. |
| A2 | Optimiser objective | Projected shortage units (engine), ties to lower spend. No margin or profit. |
| A3 | Anomaly thresholds | Fixed as in item 2; recorded as a heuristic, not evaluated precision. |
| A4 | Excess horizon | 28 days validated; 56/90 days only as a labelled approximation. |
| A5 | Assistant | Deterministic only. The LLM adapter is out of scope (needs configuration and evaluation). |
| A6 | Background jobs | None. Plans and checks are computed on request with the existing cache and bounded concurrency (an earlier decision). |
| A7 | Switches | `INVENTORY_PLANNER_ENABLED`, `INVENTORY_INSIGHTS_ENABLED` (anomaly and excess), `INVENTORY_ASSISTANT_ENABLED`. Off means the current release exactly. |

## Delivery batches (each reviewed by Codex)

| Batch | Contents |
|---|---|
| B1 | Migration 009 (decisions, plans, anomaly reviews); item 6 |
| B2 | Item 1, planner |
| B3 | Item 3, excess / slow mover |
| B4 | Item 2, anomaly checks |
| B5 | Item 5, outcomes |
| B6 | Item 4, assistant |
| B7 | Extended journey integration test; browser evidence at 390 / 768 / 1440; migration 009 rehearsal and activation on the laptop; operations and rollback docs; final checklist and report; final commit |

**Completion** is claimed only when every item above is delivered, or its data dependency is recorded as stated here.
