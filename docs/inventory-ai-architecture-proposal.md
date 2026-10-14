# Inventory AI — architecture proposal

Status: proposed for owner review; no application implementation authorized by this document.
Baseline inspected: main, merge commit e6d20ee. Forecast release: nexus-v2-shared-20261008.

## 1. Product and research objective

Build a seller-specific inventory decision-support system that predicts shortages and excess stock, recommends replenishment under real constraints, explains its decisions, and measures subsequent outcomes.

Research question: does uncertainty-aware, constraint-aware replenishment reduce unfulfilled demand and excess inventory compared with static thresholds and simple moving-average policies, under the same budget and supplier conditions?

AI contributes demand uncertainty, supplier-delay estimates, abnormal-pattern detection and grounded explanations. Stock accounting, ownership, constraints and purchase approval remain deterministic. More models do not by themselves establish a stronger AI contribution.

## 2. Current implementation and gaps

Inspected frontend/src/app/inventory/page.jsx, backend/routes/data.js, backend/migrations/001_baseline.sql and ml/v2/forecast.py.

- Inventory currently stores stock_level, reorder_threshold and updated_at against a product. There is no dependable effective stock timestamp, movement ledger, reservation history or purchase-order lifecycle.
- The alerts endpoint returns at most ten products below their threshold, with a generic restock action. It does not consume v2. It also omits product_id/category expected by the frontend.
- The inventory page uses sample products on an empty response or API failure; a healthy empty alert list therefore becomes sample alerts. Replace this with separate empty, error and explicit demo states.
- The upload path overwrites inventory from the last row carrying stock. File order and upload time cannot establish when that stock was physically measured.
- Product listing coalesces missing inventory to zero. The new inventory API must distinguish missing stock from a measured zero.
- Forecast v2 provides independently predicted 7/28-day totals, not daily paths, stockout probabilities or prediction intervals. It forecasts after the last confirmed sales date, which may be old.

## 3. System boundaries

Keep the existing Next.js frontend, Express backend, PostgreSQL and Python ML service. Use modules inside those services rather than a new fleet of microservices.

Flow:

1. Source imports, connector snapshots, stock counts and receipts enter the ownership-scoped data layer.
2. A readiness service validates stock freshness, sales completeness, source/location mappings, commitments and supplier settings.
3. A forecast adapter obtains versioned v2 outputs; later an independently evaluated inventory uncertainty model can supply demand scenarios.
4. A Python planning service evaluates stock trajectories and feasible orders.
5. Express saves the complete decision snapshot and serves structured recommendations.
6. The UI offers explanations, scenario comparison and draft purchase orders.
7. Subsequent sales, receipts and stock counts provide outcome evidence and model monitoring.

Use a background worker for batch plans and simulation. A PostgreSQL jobs table is sufficient initially; the UI reads the latest completed run and its age. Prevent one slow product from blocking the entire inventory list. Cache by seller, product, location, data revision, forecast release and policy revision. Expire recommendations after relevant stock, sales, coverage, receipt or policy changes.

## 4. Data foundation

All records carry seller ownership, business timezone where relevant, provenance, effective time and recorded time. Ownership is derived from authentication, never trusted from request input. Enforce cross-table ownership with constraints, following the forecasting work.

| Entity | Main contents |
|---|---|
| inventory_locations | Seller warehouse/location; one default location initially |
| inventory_snapshots | Product/location, on-hand quantity, observed_at, recorded_at, source/import, reconciliation status |
| inventory_movements | Receipt, shipment, return-to-stock, damage, transfer or count adjustment; signed quantity, effective time, unique source event, reversal link |
| stock_commitments | Reservations/backorders, fulfillment state and order identity; explicit representation prevents double counting |
| suppliers and product_suppliers | Supplier, product link, quoted lead time, cost/currency, MOQ, pack size, capacity and validity dates |
| purchase_orders, lines, receipts | Draft/approved/ordered/partially received/received/cancelled states, promised arrival, actual partial receipts and remaining quantities |
| inventory_policies | Review interval, planning horizon, buffer or service target, seller budget, capacity and freshness tolerance; provenance of each setting |
| inventory_runs and recommendations | Input snapshot IDs, forecast dates/release, settings, outputs, assumptions, blockers, solver status, creation time and expiry |
| recommendation_events | Seller accepts, edits, rejects or snoozes, reason and resulting draft order |
| model_evaluations | Dataset splits, release hashes, calibration and policy simulation results |

An implementation may combine tables where lifecycle semantics stay explicit. Do not turn every field into a separate service.

### Stock semantics

- Physical stock, sellable stock, reserved stock and inbound stock are distinct.
- Never sum connector stock snapshots across sales channels unless they represent distinct physical locations. Multiple channels can refer to the same warehouse.
- A snapshot is an absolute observation; a movement is a delta. Establish a cutoff and source mode so the same sale is not deducted once in a snapshot and again as a movement.
- Historical sales uploads must not automatically decrement today's stock. Deduct only live, identified fulfillment events under an explicit integration contract.
- Preserve import rollback semantics using linked reversals or recomputation; do not erase physical receipt history or silently restore stale counts.
- Legacy stock becomes an unverified opening observation requiring confirmation. updated_at alone is not proof of physical freshness.
- Each SKU has a defined unit. Initially support the application's discrete units; weighted retail data needs a separate unit adapter, not rounding into item counts.

## 5. Readiness and fallback contract

Return machine-readable state, human explanation and corrective action for each product.

| Situation | Allowed output |
|---|---|
| Current verified stock + current eligible forecast | Forecast-driven planning |
| No confirmed history / fewer than 28 days | Stock facts and explicitly configured manual-threshold alert; no invented AI forecast |
| 28–179 days | Average-based planning with the method shown |
| Stock missing | Ask for a stock count; unknown is not zero |
| Stock or forecast stale | Show dated historical information; refresh before a current actionable plan |
| Supplier lead time missing | Horizon stock-gap estimate; request lead time for a supplier-aware order recommendation |
| Cost missing | Unit planning only; exclude from monetary optimization and state why |
| Forecast/ML service unavailable | Explicit unavailable state or dated cached result; never silently substitute legacy forecasts |
| Demand estimate zero | No finite depletion estimate; no claim of unlimited stock safety |
| Missing reservations/inbound completeness | Provisional plan with explicit assumptions, not a silently complete stock position |

For first delivery require forecast origin to align with the planning business date and a sufficiently fresh stock observation. Do not move old forecast dates to today. Intraday stock against full-day demand needs a documented conservative approximation until intraday forecasting exists.

## 6. Intelligence capabilities

### A. Sales-driven stock outlook — first delivery

Reuse the approved v2 release. Report available stock versus 7-day and 28-day predicted sales, projected horizon gaps and approximate cover.

For an aligned origin, no intervening receipts and explicitly accounted commitments:

`estimated daily rate = forecast_7 / 7`

`approximate cover = available stock / estimated daily rate`

This is a rate-based approximation, not an exact stockout date. Describe horizon shortage as a projected gap, not a percentage probability.

v2's independent outputs may yield forecast_28 < forecast_7. Detect this. Do not derive negative week-2-to-4 demand or silently change published forecasts. Flag cross-horizon inconsistency and limit trajectory-based advice until a documented coherent planning forecast is available.

### B. Demand uncertainty — core research extension

Compare pooled out-of-sample residual scenarios with quantile gradient boosting. Quantile models estimate multiple possible cumulative sales levels rather than assuming the point forecast is certain. Use separate training, calibration and test periods and SKU/store splits.

Extend supported horizons deliberately, for example 1–28 days for daily planning and validated longer horizons where supplier lead time requires them. This is a new inventory forecast release, not an unreviewed change to v2. Use coherent nonnegative paths or a jointly consistent distribution; marginal quantiles alone do not supply a joint daily scenario distribution.

The output should support cumulative demand over lead time plus review period. Check quantile ordering, temporal dependence, cross-horizon coherence and empirical coverage. Quantiles are not automatically calibrated. Separate rare-sale methods may be needed. Preserve dependence between products in store-wide stress simulations where possible, and report independence assumptions if used.

Until this is validated, use named low/base/high scenarios with explicit assumptions, not claimed probabilities. A 90% service target is a seller policy, not evidence that the system achieves 90% service.

### C. Supplier lead-time intelligence

Record order placement, promised arrival, first receipt, full receipt, partial quantities and cancellations. Start with seller-entered lead time. Compare empirical supplier delivery distributions with a pooled regression/quantile model as real observations accumulate.

Potential features: supplier, product category, quantity, season, route and prior observed delivery performance. Never use information unavailable at order time. Pending late orders are not zero-day deliveries and must not be dropped in a way that makes the supplier appear faster. Model partial receipt timing or state that the initial target is full completion time.

Output arrival estimates and delay scenarios, with origin of estimate and supporting sample size. Promote learned estimates only when they beat the declared/empirical baseline on future orders. No arbitrary universal minimum count proves reliability.

### D. Inventory anomaly detection

Start with explainable accounting checks and robust residual thresholds. Evaluate an Isolation Forest or similar unsupervised model once meaningful movement history exists.

Detect unexpected count discrepancies, unusual damage/returns, stock drops inconsistent with fulfillments and abrupt sales changes. An anomaly prompts investigation; it does not automatically delete data or accuse someone of theft. Treat real large orders as valid unless evidence establishes an error. Evaluate alert precision and review burden using adjudicated cases; synthetic anomalies only establish controlled test performance.

### E. Excess-stock and slow-mover intelligence

Use stock age, receipts, demand scenarios, recent selling frequency and unit cost to estimate units likely to remain beyond a selected horizon. Value excess stock at unit cost when known; selling price is not inventory cost.

Distinguish long-held stock from demonstrably expired stock. Expiry-specific advice requires lot/expiry data. Suggested actions: pause reordering, investigate, consider a seller-approved promotion, or transfer only when separate locations exist. A promotion scenario is not a validated causal estimate of price response.

## 7. Replenishment decision engine

For a basic periodic-review policy, a target stock level covers demand during supplier lead time L plus review interval R, with an explicit buffer:

`inventory position = physical usable stock + eligible open inbound - outstanding commitments`

Commitments include reservations/backorders exactly once. If the calculation starts with already-unreserved stock, do not subtract reservations again. Confirm whether forecast demand includes existing customer orders to avoid counting those orders twice.

`raw order = max(0, target stock - inventory position)`

Then enforce integer units, pack multiples, MOQ, budget, supplier and storage limits. MOQ applies only when an order is placed. Rounding upward may breach budget/capacity; solve the constraints together rather than rounding a supposedly final optimum afterwards.

For the research policy, choose feasible quantities by minimizing expected holding, shortage and ordering costs over demand/arrival scenarios. Include procurement spend in the budget and define terminal inventory value consistently; do not double-count it as waste. With weak cost data, present explicit cost scenarios and Pareto trade-offs rather than fabricate profit.

Use OR-Tools CP-SAT with integer-scaled costs/quantities and finite candidate order levels or an appropriately linearized scenario objective. Save solver feasibility, time limit and objective bound/gap. Do not call a time-limited feasible result globally optimal. Compare with a simple greedy budget allocator.

Time matters: an order arriving after a shortage cannot prevent it. The planning simulator evaluates receipts on their arrival dates, including partial receipts and existing orders. A scalar stock position is insufficient for identifying pre-arrival shortages.

For initial v2-only planning, restrict automated numerical suggestions to supported aligned horizons. Arbitrary L+R estimates from a constant daily rate must be labeled approximation/scenario; beyond validated coverage, request a longer-horizon model or manual plan.

## 8. Simulation and policy evaluation

The simulator runs each historical decision day with only information available at that time. It advances arrivals, stock, fulfilled demand, lost demand or backorders under a declared policy, and charges defined costs. Freeze event ordering and lost-sales/backorder conventions.

Compare:

1. Existing static threshold policy with a specified order-quantity rule.
2. 28-day-average replenishment.
3. v2 point-forecast replenishment.
4. Uncertainty-aware replenishment.
5. Uncertainty-aware replenishment with budget/pack/MOQ constraints and supplier-delay scenarios.

Hold starting stock, lead-time scenarios, budget, event ordering and costs constant across methods. Use common random seeds/scenario paths. Report fill rate, shortage units, stockout days, average inventory, holding/ordering cost, spend, excess stock and feasibility violations. Include ablations showing the contribution of forecasting, uncertainty and optimization separately.

For prediction models report MAE/WAPE where defined, bias, quantile loss and empirical coverage by product group. For uncertainty about comparisons, resample at independent product/store units, not overlapping forecast rows. Report variation across cost and lead-time assumptions.

Sales during stockouts are censored: zero observed sales does not establish zero customer demand. Use M5 for sales-forecast comparisons and transparently assumed inventory simulations, not proof of actual lost sales recovered. Study FreshRetailNet-50K separately for availability/censoring experiments; its normalized quantities and fresh-food domain require a deliberate adapter. Public demand data does not provide your sellers' actual supplier delays or purchase costs.

Reserve fresh untouched final evaluation data before new model development. The completed forecasting holdout cannot become the tuning set and then be reported as a fresh final test. Reused datasets and simulation-only results must be labeled accordingly.

Live evaluation initially runs in shadow mode: recommendations are recorded without automatic purchase. Seller acceptance alone is not a correct-order label or proof of benefit. Compare predicted and observed outcomes; causal benefit claims require a suitable controlled design.

## 9. Grounded inventory assistant

Add an assistant after structured recommendations work. It answers questions such as: Why reorder this item? What changes if delivery is three days late? Which orders fit my budget?

The assistant calls seller-scoped read tools and the scenario service. All quantities, dates and costs come from stored results; arithmetic is performed by the planning service. Responses link to the recommendation and disclose assumptions. Treat imported descriptions and supplier notes as data, not tool instructions. Use deterministic explanations when no LLM is configured.

The seller must explicitly approve a draft purchase order. Natural-language conversation cannot silently change stock, send a supplier order or change policies. A plan acceptance records intent; it does not immediately create on-hand stock. Receipts update stock.

## 10. UI and API contract

One Inventory workspace, with product-level detail:

- Overview: projected shortages, products with excess stock, pending arrivals and products blocked by missing data. Counts are computed across all seller products, independently of pagination.
- Action queue: urgency, proposed action, quantity, cost when known, method, data age and next step. Unknown is not healthy. No automatic sample fallback.
- Product drawer: stock observation, commitments, supplier settings, 7/28-day outlook, explanation and history. Curves appear only when a daily trajectory/scenario exists; totals alone should remain totals.
- Replenishment planner: budget, review interval, service preference, proposed quantities, constraints and unserved needs; compare scenarios before saving a draft.
- Supplier view: quoted and observed delivery behavior with sample counts.
- Outcomes view: forecast errors and realized stock outcomes, with simulation visibly separated from actual results.

Suggested backend routes:

- GET /api/inventory/overview and /items (paginated)
- GET /api/inventory/items/:id (facts, readiness, latest recommendation)
- POST /api/inventory/snapshots and /adjustments (authenticated, idempotent)
- GET/PATCH /api/inventory/items/:id/policy
- POST /api/inventory/plans and GET /plans/:id (asynchronous)
- POST /api/inventory/scenarios
- POST /api/purchase-orders; explicit approval/cancel/receipt actions
- POST /api/inventory/recommendations/:id/decision

Forecast and inventory must share a backend forecast service/history contract, not call each other through user-facing routes. Python receives the authorized numerical context and returns structured calculations; Express owns authentication and persistence.

Responses carry status, as_of, stock_observed_at, forecast_origin, model_release, method, assumptions, blocked_reasons, inputs and recommendation. Store input revisions and reject purchase approval if the recommendation has become stale; ask the seller to review the recomputed plan. Keep manual inventory usable if the ML service is down.

## 11. Delivery sequence and completion gates

1. Stock and supplier foundation: snapshots, effective times, units, source/location mapping, minimal purchase orders/receipts, optional commitments, manual settings and readiness states. Demonstrate idempotency, seller isolation and no stock double deduction.
2. Forecast-linked Inventory MVP: use frozen v2, aligned dates, all-products view, horizon gaps, approximate cover and explicit fallbacks. No new model training yet. Demonstrate regular, rare, insufficient, unconfirmed, stale and unknown-stock cases.
3. Simulator and experiment protocol: establish baselines and untouched final split before trying improvements. Document assumptions and selected primary outcome/trade-off.
4. Uncertainty model and optimizer: evaluate candidates, integrate only validated improvements, show honest solver status and constraints. Demonstrate budget/pack/MOQ infeasibility and late arrivals.
5. Supplier learning and anomaly detection: collect the required evidence, compare baselines and promote separately. Capability remains manual/experimental where real data is insufficient.
6. Grounded assistant and product finish: explanations, scenario comparison, approval workflow, responsive/accessibility checks and final experiment report.

This preserves the ambitious final scope while allowing an operational module to exist before every model has sufficient training data.

Proposed defaults for owner review: one physical location initially, discrete units, one currency per plan, seller-entered supplier settings initially, advisory purchase drafts, and a balanced policy chosen explicitly by the seller. Adding multiple locations, perishables or automated purchasing is a separately approved extension.

## 12. Source references

- XGBoost quantile regression: https://xgboost.readthedocs.io/en/release_3.2.0/python/examples/quantile_regression.html
- scikit-learn time-series features, temporal evaluation and quantile estimates: https://scikit-learn.org/stable/auto_examples/applications/plot_time_series_lagged_features.html
- OR-Tools CP-SAT constraints and solver statuses: https://developers.google.com/optimization/cp/cp_solver
- FreshRetailNet-50K authors' dataset: https://huggingface.co/datasets/Dingdong-Inc/FreshRetailNet-50K
- FreshRetailNet-50K paper: https://arxiv.org/abs/2505.16319

These support candidate methods and datasets, not a claim that the proposed NexusCommerce inventory system is already validated.
