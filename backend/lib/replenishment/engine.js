// Stage 2 replenishment engine — a PURE calculation: (inputs) → result.
//
// No database, no clock, no I/O. The planning date and every fact arrive in
// `inputs` (built by ./inputs.js); the same inputs always give the same result.
// Nothing here writes stock, creates or approves orders, or changes a policy.
//
// Contract: ENGINE_VERSION below. Any change to the arithmetic, the inputs it
// reads or the result shape needs a new version (it is part of the recommendation
// log's identity and of the draft-consistency fingerprint).
//
// Conventions (shown to the seller wherever they affect a number):
//   A1  v2 gives two totals (7 and 28 days) and no daily curve. Inside each block
//       (forecast days 1–7 and 8–28) demand is spread evenly. Used only when the
//       two totals are consistent (T28 ≥ T7); otherwise no order quantity.
//   A2  A dated delivery is usable the day AFTER its expected date.
//   A3  Demand that cannot be met is lost, not back-ordered (stock never < 0).
//   A4  The planning day (today) counts as a full day of demand still to come.
//       Nothing assumes today's sales are finished.
'use strict';

const ENGINE_VERSION = 'replenishment-1';
// With the store calendar (Stage 3a, INVENTORY_CALENDAR_ENABLED) the engine reads seller-entered closures,
// supplier delays, demand scenarios and the declared slowest lead time: a different input contract, so a
// different version. Without a calendar input the arithmetic and the result are exactly replenishment-1.
const ENGINE_VERSION_CALENDAR = 'replenishment-2';
const FORECAST_MAX_LAG_DAYS = 7;      // documented forecast-age limit (separate from the stock tolerance)
const DEFAULT_REVIEW_DAYS = 7;
const DEFAULT_SAFETY_STOCK = 0;
const EPS = 1e-9;

const DAY_MS = 86400000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const r2 = (x) => (x === null || x === undefined ? x : Math.round((x + Number.EPSILON) * 100) / 100);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// Whole units: tolerate floating noise (31.000000001 is 31, not 32).
const wholeUp = (x) => (x <= EPS ? 0 : Math.ceil(x - 1e-6));

const ASSUMPTIONS = {
  A1: 'The 7- and 28-day forecast totals are spread evenly inside each block (forecast days 1–7 and 8–28). The forecast gives no daily figures, so the day on which stock runs out is not known precisely.',
  A2: 'A delivery is usable the day after its expected arrival date.',
  A3: 'Demand that cannot be met from stock is lost, not back-ordered.',
  A4: 'Today counts as a full day of demand still to come; nothing assumes today\'s sales are finished.',
  C1: 'On a closure day you entered, there are no sales and nothing is received; a delivery due then is usable from the next open day.',
  C2: 'A demand change you entered multiplies the forecast on its dates. It is your assumption, not a prediction.',
  C3: 'A supplier delay you entered adds its days to an order whose expected arrival falls inside its dates.',
};

// ── Demand on the planning grid ──────────────────────────────────────────────
// Planning day k (1-based) is date D + k − 1. With forecast lag g = D − F,
// planning day k is forecast day j = k + g. Forecast day j is ALWAYS date F + j − 1:
// a forecast is never shifted to start today.
function demandGrid(t7, t28, g, basis) {
  if (basis === 'blocks') {           // A1, consistent horizons only
    const covered = 28 - g;
    return Array.from({ length: covered }, (_, i) => (i + 1 + g <= 7 ? t7 / 7 : (t28 - t7) / 21));
  }
  if (basis === 'rate_7') {           // independent estimate from the 7-day total only
    return Array.from({ length: Math.max(0, 7 - g) }, () => t7 / 7);
  }
  return Array.from({ length: 28 - g }, () => t28 / 28); // 'rate_28'
}

// Daily simulation (A3: lost sales). arrivals: Map(planning day → units usable that day).
function simulate(start, demand, arrivals, extra = null) {
  let stock = start;
  return demand.map((d, i) => {
    const day = i + 1;
    const available = stock + (arrivals.get(day) || 0) + (extra && extra.day === day ? extra.quantity : 0);
    const sold = Math.min(available, d);
    stock = available - sold;
    return { day, available, sold, short: d - sold, end: stock };
  });
}

function horizonOutlook(D, h, demand, rows, arrivals) {
  const days = Math.min(h, demand.length);
  if (days <= 0) return { horizon_days: h, start: D, end: null, covered_days: 0, complete: false, label: 'Not covered by the forecast' };
  const out = {
    horizon_days: h, start: D, end: addDays(D, days - 1), covered_days: days, complete: days === h,
    label: days === h ? `${h} days` : `${days} days covered (of ${h})`,
    demand: r2(sum(demand.slice(0, days))),
    incoming_counted: sum([...arrivals].filter(([day]) => day <= days).map(([, q]) => q)),
  };
  if (rows) {
    out.stock_at_end = r2(rows[days - 1].end);
    out.shortage_units = r2(sum(rows.slice(0, days).map(r => r.short)));
    out.runs_short = out.shortage_units > EPS;
  }
  return out;
}

// Smallest extra quantity Q, usable on day a, so that no day a..a+R−1 is short and the
// window ends with at least SS. Because nothing is short inside the window once Q is
// added, the balance there is linear in Q:  B_k(Q) = stock_{a−1} + Q + Σ_{i=a..k}(arrivals_i − demand_i).
// So Q* = max(0, −min_k B_k(0), SS − B_end(0)) — every daily checkpoint is checked,
// not only the final balance.
function minimumQuantity({ start, demand, arrivals, a, R, SS }) {
  const base = simulate(start, demand, arrivals);
  const atArrival = base[a - 2] ? base[a - 2].end : start;
  let balance = atArrival;
  let lowest = Infinity;
  let lowestDay = null;
  for (let k = a; k <= a + R - 1; k += 1) {
    balance += (arrivals.get(k) || 0) - demand[k - 1];
    if (balance < lowest - EPS) { lowest = balance; lowestDay = k; }
  }
  const forShortage = Math.max(0, -lowest);
  const forSafety = Math.max(0, SS - balance);
  const raw = Math.max(forShortage, forSafety);
  let binding = 'none';
  if (raw > EPS) binding = forShortage + EPS >= forSafety && forShortage > EPS ? 'shortage_inside_window' : 'safety_stock_at_window_end';
  return { base, atArrival, raw, forShortage, forSafety, binding, lowestDay, endWithout: balance };
}

function supplierSteps(rawUnits, terms) {
  const moq = terms.min_order_qty || 1;
  const pack = terms.pack_size || 1;
  if (rawUnits === 0) return { after_minimum: 0, minimum_adjustment: 0, pack_adjustment: 0, quantity: 0 };
  const afterMin = Math.max(rawUnits, moq);
  const quantity = Math.ceil(afterMin / pack) * pack;
  return { after_minimum: afterMin, minimum_adjustment: afterMin - rawUnits, pack_adjustment: quantity - afterMin, quantity };
}

// Order quantity + the projected outcome after adding it.
function orderSuggestion(ctx, start, arrivals) {
  const { D, demand, a, R, SS, terms, scheduled } = ctx;
  const m = minimumQuantity({ start, demand, arrivals, a, R, SS });
  const rawUnits = wholeUp(m.raw);
  const steps = supplierSteps(rawUnits, terms);
  const windowEndDay = a + R - 1;
  const after = simulate(start, demand, arrivals, steps.quantity > 0 ? { day: a, quantity: steps.quantity } : null);
  const inWindow = after.slice(a - 1, windowEndDay);
  const withOrder = new Map(arrivals);
  if (steps.quantity > 0) withOrder.set(a, (withOrder.get(a) || 0) + steps.quantity);
  // What makes the minimum binding, in terms the seller can check (no stockout dates).
  let bindingDetail = null;
  if (m.binding === 'shortage_inside_window') {
    const next = scheduled.filter(s => s.usable_day === m.lowestDay + 1);
    bindingDetail = next.length
      ? { kind: 'before_delivery', delivery_usable_from: addDays(D, m.lowestDay), po_ids: next.map(s => s.po_id) }
      : { kind: 'window_end' };
  } else if (m.binding === 'safety_stock_at_window_end') {
    bindingDetail = { kind: 'safety_stock' };
  }
  return {
    window: { start: addDays(D, a - 1), end: addDays(D, windowEndDay - 1), days: R, first_day: a, last_day: windowEndDay },
    stock_when_order_usable: r2(m.atArrival),
    demand_in_window: r2(sum(demand.slice(a - 1, windowEndDay))),
    incoming_in_window: sum(scheduled.filter(s => s.usable_day >= a && s.usable_day <= windowEndDay).map(s => s.quantity)),
    needed_to_avoid_shortage: r2(m.forShortage),
    needed_for_safety_stock: r2(m.forSafety),
    binding: m.binding,
    binding_detail: bindingDetail,
    raw_need: r2(m.raw),
    raw_units: rawUnits,
    ...steps,
    cost: steps.quantity > 0 && terms.unit_cost !== null && terms.unit_cost !== undefined
      ? { amount: r2(steps.quantity * Number(terms.unit_cost)), currency: terms.currency } : null,
    after_order: {
      quantity: steps.quantity,
      usable_from: addDays(D, a - 1),
      shortage_in_window: r2(sum(inWindow.map(r => r.short))),
      lowest_stock_in_window: r2(Math.min(...inWindow.map(r => r.end))),
      stock_at_window_end: r2(after[windowEndDay - 1].end),
      safety_stock_met: after[windowEndDay - 1].end + 1e-6 >= SS,
      // Shortage before the order is usable cannot be changed by this order: reported separately.
      shortage_before_usable: r2(sum(after.slice(0, a - 1).map(r => r.short))),
      // After the review window the next review decides; shown so nothing is hidden.
      shortage_after_window_within_forecast: r2(sum(after.slice(windowEndDay).map(r => r.short))),
      outlook: {
        7: horizonOutlook(D, 7, demand, after, withOrder),
        28: horizonOutlook(D, 28, demand, after, withOrder),
      },
    },
  };
}

function classifyIncoming(D, lines) {
  const scheduled = [];
  const overdue = [];
  const undated = [];
  for (const l of lines) {
    const item = { po_id: l.po_id, quantity: l.quantity, expected_arrival: l.expected_arrival || null, status: l.status };
    if (!l.expected_arrival) undated.push(item);
    else if (l.expected_arrival < D) overdue.push({ ...item, days_overdue: daysBetween(l.expected_arrival, D) });
    else {
      const usableDay = daysBetween(D, l.expected_arrival) + 2; // A2
      scheduled.push({ ...item, usable_from: addDays(l.expected_arrival, 1), usable_day: usableDay });
    }
  }
  return { scheduled, overdue, undated };
}

const CODES = {
  stock_missing: ['No stock count has been recorded for this product.', 'Record a stock count.'],
  stock_unverified_only: ['Only an unverified value from before the inventory ledger exists; it has no count time, so it is not used.', 'Record a stock count.'],
  stock_inconsistent: ['Recorded movements since the last count take stock below zero, so the stock figure cannot be used.', 'Recount this product.'],
  forecast_no_sales: ['No sales are recorded for this product, so there is no forecast.', 'Upload sales history.'],
  forecast_needs_confirmation: ['Sales are recorded but no period is confirmed as complete, so there is no forecast.', 'Confirm the period each upload covers on the Data Integration page.'],
  forecast_insufficient_history: ['Fewer than 28 consecutive confirmed days of sales, so there is no forecast.', 'Upload and confirm more sales history.'],
  forecast_too_old: ['The forecast starts too long ago to plan from today.', 'Upload and confirm recent sales.'],
  supplier_missing: ['No active supplier is linked to this product.', 'Link a supplier on the Suppliers tab.'],
  supplier_choice_needed: ['Several active suppliers are linked and none is preferred.', 'Mark one supplier as preferred for this product.'],
  lead_time_missing: ['The supplier\'s lead time is not set.', 'Set the lead time in the supplier terms.'],
  horizon_beyond_forecast: ['The lead time plus the review period reaches beyond the days the forecast covers.', 'Shorten the review period, or plan this order manually.'],
  timezone_mismatch: ['Sales dates and the stock location use different timezones, so their days are not the same time intervals.',
    'Use the same timezone for the sales source and the stock location.'],
  calendar_conflict: ['More than one demand change you entered applies to the same day for this product, so it is not clear which one you mean.',
    'Edit or cancel one of the overlapping calendar entries.'],
};
const need = (code, extra = {}) => ({ code, message: CODES[code][0], action: CODES[code][1], ...extra });

// ── Store calendar (replenishment-2 only) ─────────────────────────────────────
// Planning day k is date D + k − 1. Closures zero demand and move usability to the next open day;
// demand changes multiply the forecast (two on one day are a conflict, never combined silently).
function calendarPlan(D, cal, days) {
  const dates = Array.from({ length: days }, (_, i) => addDays(D, i));
  const closed = new Set();
  const factor = Array(days).fill(1);
  const conflicts = [];
  const applied = [];
  for (const e of cal.closures || []) {
    const hit = dates.map((d, i) => (d >= e.start_date && d <= e.end_date ? i + 1 : null)).filter(Boolean);
    hit.forEach(k => closed.add(k));
    if (hit.length) applied.push({ ...e, effect: 'closure', label: 'declared_by_seller', planning_days: hit.length });
  }
  const owner = Array(days).fill(null);
  for (const e of cal.demand_changes || []) {
    let n = 0;
    dates.forEach((d, i) => {
      if (d < e.start_date || d > e.end_date) return;
      if (owner[i] !== null) { conflicts.push({ date: d, entries: [owner[i], e.id] }); return; }
      owner[i] = e.id;
      factor[i] = 1 + Number(e.demand_change_pct) / 100;
      n += 1;
    });
    if (n) applied.push({ ...e, effect: 'demand_change', label: 'assumed_by_seller', planning_days: n });
  }
  return { closed, factor, conflicts, applied, adjust: (grid) => grid.map((d, i) => (closed.has(i + 1) ? 0 : d * (factor[i] ?? 1))),
    adjustClosuresOnly: (grid) => grid.map((d, i) => (closed.has(i + 1) ? 0 : d)),
    open: (day) => { let k = day; while (closed.has(k)) k += 1; return k; } };
}

// Expected arrival of an order placed today with lead time L, after the supplier delays you entered.
function delayedLeadTime(D, L, delays) {
  let arrival = addDays(D, L);
  const used = [];
  for (let pass = 0; pass < 10; pass += 1) {
    const hit = (delays || []).find(e => !used.includes(e.id) && arrival >= e.start_date && arrival <= e.end_date);
    if (!hit) break;
    used.push(hit.id);
    arrival = addDays(arrival, hit.extra_delay_days);
  }
  return { lead_time_days: daysBetween(D, arrival), extra_days: daysBetween(D, arrival) - L, entries: used };
}

// ── Main ─────────────────────────────────────────────────────────────────────
function recommend(inputs) {
  const D = inputs.planning_date;
  const missing = [];
  const indicativeReasons = [];
  const warnings = [];
  const limitations = [];
  const usedAssumptions = new Set();

  // Stock ------------------------------------------------------------------
  const st = inputs.stock;
  const stockKnown = (st.state === 'last_known' || st.state === 'stale') && Number.isFinite(st.on_hand) && st.on_hand >= 0;
  if (st.state === 'missing') missing.push(need('stock_missing'));
  else if (st.state === 'unverified_only') missing.push(need('stock_unverified_only', { legacy_quantity: st.legacy_quantity ?? null }));
  else if (st.state === 'inconsistent') missing.push(need('stock_inconsistent', { on_hand: st.on_hand }));
  if (stockKnown) {
    limitations.push({ code: 'stock_last_known',
      text: `Stock is the last-known position: counted on ${st.count_business_date} (${st.count_age_days} day(s) ago) plus recorded movements. `
        + ({ absent: 'No shipment feed is declared, so sales since the count are not subtracted.',
          partial: 'Some sales since the count came from a source or day that no declared shipment feed covers.',
          declared_unverified: 'A shipment feed is declared, but its completeness is not verified.' }[st.movement_tracking] || '') });
    const rec = st.reconciliation;
    if (rec && rec.state === 'needs_review') {
      const ev = (rec.events || []).map(e => `${e.kind} ${e.quantity > 0 ? '+' : ''}${e.quantity}`).join(', ');
      const text = `${rec.same_instant_events || (rec.events || []).length} recorded movement(s)${ev ? ` (${ev})` : ''} carry exactly the count's time, so it cannot be established whether the count already includes them. The stock figure may be off by that amount. Check those events or record a new count before ordering.`;
      indicativeReasons.push({ code: 'stock_needs_reconciliation', text, events: rec.events || [] });
      warnings.push({ code: 'stock_needs_reconciliation', text });
    }
    if (st.state === 'stale') {
      indicativeReasons.push({ code: 'stock_stale',
        text: `The last count is ${st.count_age_days} days old; your tolerance is ${st.stale_after_days} days. Record a new count before ordering.` });
    }
  }

  // Policy -----------------------------------------------------------------
  const pol = inputs.policy || {};
  const R = pol.review_period_days ?? DEFAULT_REVIEW_DAYS;
  const SS = pol.safety_stock_units ?? DEFAULT_SAFETY_STOCK;
  const policy = {
    review_period_days: R, review_period_source: pol.review_period_days == null ? 'default' : (pol.review_period_source || 'seller'),
    safety_stock_units: SS, safety_stock_source: pol.safety_stock_units == null ? 'default' : (pol.safety_stock_source || 'seller'),
  };
  if (policy.review_period_source === 'default') {
    limitations.push({ code: 'review_period_default', text: `The review period of ${R} days is the default, not your setting. The order is sized to last until the next review ${R} days after it arrives.` });
  }
  limitations.push(SS > 0
    ? { code: 'safety_stock_seller_set', text: `Safety stock of ${SS} unit(s) is your setting. It is not a calculated protection level and says nothing about how likely a shortage is.` }
    : { code: 'no_safety_stock', text: 'No safety stock is set, so the suggestion covers expected demand only. Actual sales above the forecast would cause a shortage.' });

  // Supplier ---------------------------------------------------------------
  const sup = inputs.supplier || { state: 'missing' };
  if (sup.state === 'missing') missing.push(need('supplier_missing'));
  else if (sup.state === 'choice_needed') missing.push(need('supplier_choice_needed', { active_links: sup.active_links }));
  else if (sup.lead_time_days === null || sup.lead_time_days === undefined) {
    missing.push(need('lead_time_missing', { action: `Set the lead time for ${sup.name}.` }));
  }
  const L = sup.state === 'ok' ? sup.lead_time_days : null;
  const leadKnown = Number.isInteger(L) && L >= 0;

  // Incoming ---------------------------------------------------------------
  const inc = classifyIncoming(D, inputs.incoming || []);
  const uncertainUnits = sum(inc.overdue.map(x => x.quantity)) + sum(inc.undated.map(x => x.quantity));
  const notPlaced = inputs.not_placed || { approved: [], drafts: [] };
  for (const o of inc.overdue) {
    warnings.push({ code: 'incoming_overdue', po_id: o.po_id,
      text: `PO-${o.po_id}: ${o.quantity} unit(s) were expected on ${o.expected_arrival} and are not received. They are not counted. Check with the supplier before ordering again.` });
  }
  for (const o of inc.undated) {
    warnings.push({ code: 'incoming_undated', po_id: o.po_id,
      text: `PO-${o.po_id}: ${o.quantity} unit(s) have no expected arrival date, so they are not counted. Add the supplier's promised date.` });
  }
  for (const o of notPlaced.approved || []) {
    warnings.push({ code: 'approved_not_sent', po_id: o.po_id,
      text: `PO-${o.po_id}: an approved order for ${o.quantity} unit(s) is not marked as ordered. It is not counted as incoming — avoid ordering twice.` });
  }
  for (const o of notPlaced.drafts || []) {
    warnings.push({ code: 'draft_open', po_id: o.po_id,
      text: `PO-${o.po_id}: a draft order for ${o.quantity} unit(s) exists. It is not counted as incoming — avoid ordering twice.` });
  }

  const cal = inputs.calendar || null;
  const result = {
    engine_version: cal ? ENGINE_VERSION_CALENDAR : ENGINE_VERSION,
    product_id: inputs.product_id,
    planning_date: D,
    timezone: inputs.timezone,
    scenario: inputs.scenario || null,
    status: null,
    actionable: false,
    stock: { state: st.state, on_hand: stockKnown ? st.on_hand : null, counted_at: st.counted_at ?? null,
      count_business_date: st.count_business_date ?? null, count_age_days: st.count_age_days ?? null,
      stale_after_days: st.stale_after_days ?? null, movement_tracking: st.movement_tracking ?? null,
      legacy_quantity: st.legacy_quantity ?? null, reconciliation: st.reconciliation ?? null },
    sales_since_count: inputs.sales_since_count || null,
    forecast: null,
    incoming: { scheduled: inc.scheduled, overdue: inc.overdue, undated: inc.undated,
      approved_not_sent: notPlaced.approved || [], drafts: notPlaced.drafts || [],
      counted_units: sum(inc.scheduled.map(s => s.quantity)), uncertain_units: uncertainUnits },
    supplier: sup.state === 'ok' ? { state: 'ok', id: sup.id, name: sup.name, source: sup.source, lead_time_days: L,
      pack_size: sup.pack_size ?? null, min_order_qty: sup.min_order_qty ?? null, unit_cost: sup.unit_cost ?? null, currency: sup.currency ?? null }
      : { state: sup.state, active_links: sup.active_links ?? 0 },
    policy,
    outlook: null,
    outlook_withheld: null,
    before_arrival: null,
    suggestion: null,
    suggestion_withheld: null,
    alternative_if_uncertain_incoming_arrives: null,
    sales_adjusted_scenario: null,
    draft_blocked: null,
    assumptions: [],
    limitations,
    warnings,
    missing,
    indicative_reasons: indicativeReasons,
  };
  if (cal) {
    result.calendar = {
      country: cal.country, country_confirmed: cal.country_confirmed,
      holidays: cal.holidays || [], holiday_effect: 'not_known', holiday_effect_label: 'Effect unknown',
      holiday_note: cal.country ? 'Holidays are shown for planning; their effect on your sales is not known, so the forecast is not changed for them. Enter a closure or a demand change if you expect one.'
        : 'Confirm your country on the Calendar tab to see its holidays.',
      applied: [], promotions_without_change: cal.promotions_without_change || [],
      supplier_delay: null, incoming_in_supplier_delay: cal.incoming_in_supplier_delay || [],
      declared_lead_time_max_days: cal.declared_lead_time_max_days ?? null,
      late_delivery_scenario: null, order_by: null, quantity_without_seller_scenarios: null,
    };
    for (const x of result.calendar.incoming_in_supplier_delay) {
      warnings.push({ code: 'incoming_in_supplier_delay', po_id: x.po_id,
        text: `PO-${x.po_id} is expected on ${x.expected_arrival}, inside the supplier delay "${x.title}" (+${x.extra_delay_days} day(s)) you entered. Its date is not changed automatically: update the expected arrival if the supplier confirms the delay.` });
    }
  }

  // Forecast ---------------------------------------------------------------
  const fc = inputs.forecast || { status: 'unavailable' };
  if (fc.status === 'unavailable') {
    result.status = 'unavailable';
    result.forecast = { status: 'unavailable', message: fc.message || 'The forecast service is not available.' };
    return finish(result, usedAssumptions);
  }
  if (fc.status === 'no_sales') missing.push(need('forecast_no_sales'));
  else if (fc.status === 'needs_confirmation') missing.push(need('forecast_needs_confirmation'));
  else if (fc.status === 'insufficient') {
    missing.push(need('forecast_insufficient_history', { usable_days: fc.usable_days || 0,
      more_days_needed: Math.max(0, 28 - (fc.usable_days || 0)),
      message: `Only ${fc.usable_days || 0} consecutive confirmed day(s) of sales; ${Math.max(0, 28 - (fc.usable_days || 0))} more are needed for a forecast.` }));
  }
  if (fc.status !== 'ok') {
    result.forecast = { status: fc.status, usable_days: fc.usable_days ?? 0 };
    return finish(result, usedAssumptions);
  }

  const F = fc.origin;
  const g = daysBetween(F, D);                        // forecast lag
  const t7 = Number(fc.totals[7]);
  const t28 = Number(fc.totals[28]);
  const consistent = t28 + EPS >= t7;
  const rare = fc.pattern_group === 'rare' || fc.method === 'tsb';
  const zeroDemand = t7 <= EPS && t28 <= EPS;
  result.forecast = {
    status: 'ok', origin: F, history_end: addDays(F, -1), lag_days: g,
    lag_state: g === 0 ? 'aligned' : g < 0 ? 'starts_after_today' : g > FORECAST_MAX_LAG_DAYS ? 'too_old' : 'behind',
    max_lag_days: FORECAST_MAX_LAG_DAYS,
    method: fc.method, method_label: fc.method_label || null, pattern_group: fc.pattern_group || null,
    tier: fc.tier || null, usable_days: fc.usable_days ?? null, models_release: fc.models_release || null,
    totals: { 7: r2(t7), 28: r2(t28) },
    blocks: [7, 28].map(h => ({ horizon_days: h, start: F, end: addDays(F, h - 1), total: r2(h === 7 ? t7 : t28) })),
    horizons_consistent: consistent,
  };
  // Sale dates are business days in the sales source's timezone; the planning grid uses the
  // stock location's. Different zones mean the daily totals and the stock days are not the
  // same intervals: keep the facts, withhold the combined projection and the quantity.
  const zones = fc.source_timezones || [];
  const foreign = zones.filter(z => z !== inputs.timezone);
  if (foreign.length) {
    Object.assign(result.forecast, { lag_days: null, lag_state: 'not_comparable', dates_timezone: zones.join(', ') });
    const text = `Sales dates are in ${zones.join(' and ')}, but the stock location uses ${inputs.timezone}. The forecast totals (shown with their own dates, in the sales timezone) and the stock figure are kept separately; they are not combined into a projection or an order quantity.`;
    missing.push(need('timezone_mismatch', { sales_timezones: zones, location_timezone: inputs.timezone,
      action: `Use the same timezone for the sales source (${zones.join(', ')}) and the stock location (${inputs.timezone}).` }));
    result.outlook_withheld = { code: 'timezone_mismatch', text };
    result.suggestion_withheld = { code: 'timezone_mismatch', text: 'No quantity or draft until the sales source and the stock location use the same timezone.' };
    return finish(result, usedAssumptions);
  }
  result.forecast.dates_timezone = inputs.timezone;
  if (g > FORECAST_MAX_LAG_DAYS) {
    missing.push(need('forecast_too_old', { lag_days: g,
      message: `Confirmed sales end on ${addDays(F, -1)}, so the forecast starts ${g} days before today. Forecasts more than ${FORECAST_MAX_LAG_DAYS} days behind are not used for planning.` }));
    return finish(result, usedAssumptions);
  }
  if (g < 0) {
    // History is confirmed through today (or later). The forecast starts after today, so it
    // says nothing about today's remaining demand. Do not move the planning date and do not
    // treat today as finished: withhold the today-based outlook and quantity.
    const text = g === -1
      ? `Sales are confirmed through today (${D}), so the forecast starts tomorrow (${F}). A plan from today needs today's remaining demand, which the forecast does not cover, and today may not be finished. No outlook or order quantity is given for today; the forecast totals for ${F} onwards are shown as they are.`
      : `Sales are confirmed past today, so the forecast starts on ${F}. No outlook or order quantity is given for today.`;
    result.outlook_withheld = { code: 'forecast_starts_after_today', text };
    result.suggestion_withheld = { code: 'forecast_starts_after_today', text };
    indicativeReasons.push({ code: 'forecast_starts_after_today', text });
    return finish(result, usedAssumptions);
  }
  if (g > 0) {
    indicativeReasons.push({ code: 'forecast_lag',
      text: `Confirmed sales end on ${addDays(F, -1)}, so the forecast started ${g} day(s) before today. It covers only the next ${28 - g} of 28 days; the result is indicative. Upload and confirm recent sales for an actionable suggestion.` });
  }
  if (rare) {
    limitations.push({ code: 'rare_sales', text: 'This product sells on fewer than 20% of days, in occasional units. The even daily rate is a rough average: a single sale can empty stock, and no "days of cover" figure is given.' });
  }
  if (zeroDemand) {
    limitations.push({ code: 'zero_demand', text: 'No sales are expected in the forecast period. This does not mean stock lasts forever.' });
  }

  const scheduledArrivals = new Map();
  for (const s of inc.scheduled) scheduledArrivals.set(s.usable_day, (scheduledArrivals.get(s.usable_day) || 0) + s.quantity);
  if (inc.scheduled.length) usedAssumptions.add('A2');
  usedAssumptions.add('A3'); usedAssumptions.add('A4');
  const start = stockKnown ? st.on_hand : null;

  // Inconsistent horizons: two independent estimates, no quantity ------------
  if (!consistent) {
    const d7 = demandGrid(t7, t28, g, 'rate_7');
    const d28 = demandGrid(t7, t28, g, 'rate_28');
    const text = `The 7-day forecast (${r2(t7)} units, ${r2(t7 / 7)} a day) is higher than the whole 28-day forecast (${r2(t28)} units, ${r2(t28 / 28)} a day). The two horizons disagree, so weeks 2–4 cannot be derived and no order quantity is given. Check recent sales before ordering.`;
    result.outlook = {
      basis: 'independent_estimates',
      7: { ...horizonOutlook(D, 7, d7, start === null ? null : simulate(start, d7, scheduledArrivals), scheduledArrivals), estimate_from: '7_day_forecast', daily_rate: r2(t7 / 7) },
      28: { ...horizonOutlook(D, 28, d28, start === null ? null : simulate(start, d28, scheduledArrivals), scheduledArrivals), estimate_from: '28_day_forecast', daily_rate: r2(t28 / 28) },
      approximate_cover_days: null,
      cover_note: 'Not given: the 7- and 28-day forecasts disagree.',
    };
    warnings.push({ code: 'forecast_horizons_inconsistent', text });
    indicativeReasons.push({ code: 'forecast_horizons_inconsistent', text });
    result.suggestion_withheld = { code: 'forecast_horizons_inconsistent', text };
    return finish(result, usedAssumptions);
  }

  usedAssumptions.add('A1');
  const baseDemand = demandGrid(t7, t28, g, 'blocks');
  const covered = baseDemand.length;
  let plan = null;
  let demand = baseDemand;
  if (cal) {
    plan = calendarPlan(D, cal, covered);
    if (plan.conflicts.length) {
      missing.push(need('calendar_conflict', { conflicts: plan.conflicts.slice(0, 10) }));
      result.suggestion_withheld = { code: 'calendar_conflict', text: 'Two demand changes you entered overlap for this product; no quantity until one is changed.' };
    }
    demand = plan.adjust(baseDemand);
    result.calendar.applied = plan.applied;
    if (plan.closed.size) usedAssumptions.add('C1');
    if (plan.applied.some(x => x.effect === 'demand_change')) usedAssumptions.add('C2');
    // Deliveries due on a closed day are usable from the next open day.
    scheduledArrivals.clear();
    for (const s of inc.scheduled) {
      const k = plan.open(s.usable_day);
      if (k !== s.usable_day) { s.usable_day_before_closure = s.usable_day; s.usable_day = k; s.usable_from = addDays(D, k - 1); }
      scheduledArrivals.set(s.usable_day, (scheduledArrivals.get(s.usable_day) || 0) + s.quantity);
    }
  }
  const rows = start === null ? null : simulate(start, demand, scheduledArrivals);
  let cover = null;
  let coverNote = null;
  if (rows && !rare && !zeroDemand) {
    const first = rows.find(r => r.short > EPS);
    if (first) cover = first.day - 1;
    else coverNote = `No shortage within the ${covered} covered days.`;
  } else if (rows) {
    coverNote = rare ? 'Not given for occasional sales.' : 'Not given: no sales are expected.';
  }
  result.outlook = {
    basis: 'A1',
    7: horizonOutlook(D, 7, demand, rows, scheduledArrivals),
    28: horizonOutlook(D, 28, demand, rows, scheduledArrivals),
    approximate_cover_days: cover,
    cover_note: coverNote,
  };

  if (!leadKnown) {
    if (!result.suggestion_withheld) result.suggestion_withheld = { code: missing.find(m => m.code.startsWith('supplier') || m.code === 'lead_time_missing')?.code || 'lead_time_missing', text: 'An order quantity needs the supplier and its lead time.' };
  }
  if (!stockKnown) {
    result.suggestion_withheld = { code: 'stock_unknown', text: 'An order quantity needs a usable stock count. Unknown stock is never treated as zero.' };
  }
  if (!leadKnown || !stockKnown) return finish(result, usedAssumptions);
  if (result.suggestion_withheld) return finish(result, usedAssumptions);

  let Leff = L;
  if (cal) {
    const dl = delayedLeadTime(D, L, cal.supplier_delays);
    if (dl.extra_days > 0) {
      Leff = dl.lead_time_days;
      usedAssumptions.add('C3');
      result.calendar.supplier_delay = { label: 'declared_by_seller', lead_time_days: L, extra_days: dl.extra_days, effective_lead_time_days: Leff, entries: dl.entries,
        text: `Lead time ${L} + ${dl.extra_days} day(s) from the supplier delay you entered = ${Leff} day(s).` };
    }
  }
  const a = plan ? plan.open(Leff + 2) : L + 2;         // A2 (+C1/C3): ordered today, expected D+L, usable the day after
  const ctx = { D, demand, a, R, SS, terms: result.supplier, scheduled: inc.scheduled };
  if (a - 1 <= covered) {
    result.before_arrival = {
      order_expected: addDays(D, Leff), order_usable_from: addDays(D, a - 1), usable_day: a,
      stock_when_order_usable: r2(rows[a - 2].end),
      shortage_units: r2(sum(rows.slice(0, a - 1).map(r => r.short))),
    };
    result.before_arrival.runs_short = result.before_arrival.shortage_units > EPS;
  }
  if (a + R - 1 > covered) {
    missing.push(need('horizon_beyond_forecast', { lead_time_days: Leff, review_period_days: R, days_needed: a - 1 + R, covered_days: covered,
      message: `Ordering now needs a forecast for ${a - 1 + R} days (lead time ${Leff}${Leff !== L ? ` incl. ${Leff - L} day(s) of supplier delay` : ''} + 1 day to unpack${a - 1 > Leff + 1 ? ' + closed days' : ''} + review period ${R}); the forecast covers ${covered}.` }));
    result.suggestion_withheld = { code: 'horizon_beyond_forecast', text: missing[missing.length - 1].message };
    return finish(result, usedAssumptions);
  }

  result.suggestion = orderSuggestion(ctx, start, scheduledArrivals);
  if (cal) calendarExtras(result, { ctx, start, scheduledArrivals, plan, baseDemand, rows, D, L, Leff, covered, cal });
  if (uncertainUnits > 0) {
    // Labelled alternative: the overdue and undated quantities usable tomorrow (day 2).
    const alt = new Map(scheduledArrivals);
    alt.set(2, (alt.get(2) || 0) + uncertainUnits);
    const s = orderSuggestion(ctx, start, alt);
    result.alternative_if_uncertain_incoming_arrives = {
      label: `If the overdue and undated deliveries (${uncertainUnits} unit(s)) are usable tomorrow`,
      uncertain_units: uncertainUnits, raw_need: s.raw_need, raw_units: s.raw_units,
      minimum_adjustment: s.minimum_adjustment, pack_adjustment: s.pack_adjustment, quantity: s.quantity,
    };
  }
  const U = inputs.sales_since_count?.units_not_deducted || 0;
  if (U > 0) {
    const adjStart = Math.max(0, start - U);
    const adjRows = simulate(adjStart, demand, scheduledArrivals);
    const s = orderSuggestion(ctx, adjStart, scheduledArrivals);
    result.sales_adjusted_scenario = {
      label: `If the ${U} unit(s) sold since the count have already left stock`,
      starting_stock: adjStart,
      outlook: { 7: horizonOutlook(D, 7, demand, adjRows, scheduledArrivals), 28: horizonOutlook(D, 28, demand, adjRows, scheduledArrivals) },
      before_arrival_shortage: r2(sum(adjRows.slice(0, a - 1).map(r => r.short))),
      raw_need: s.raw_need, raw_units: s.raw_units, minimum_adjustment: s.minimum_adjustment, pack_adjustment: s.pack_adjustment,
      quantity: s.quantity, after_order: s.after_order,
    };
  }
  return finish(result, usedAssumptions);
}

// replenishment-2 extras: quantity without your demand scenarios, the declared-slowest-delivery
// scenario, and the latest order date before the first projected shortage (deterministic, no prediction).
function calendarExtras(result, { ctx, start, scheduledArrivals, plan, baseDemand, rows, D, L, Leff, covered, cal }) {
  const c = result.calendar;
  if (plan.applied.some(x => x.effect === 'demand_change')) {
    const s = orderSuggestion({ ...ctx, demand: plan.adjustClosuresOnly(baseDemand) }, start, scheduledArrivals);
    c.quantity_without_seller_scenarios = { quantity: s.quantity, raw_units: s.raw_units,
      label: 'Without your demand changes (forecast only; closures still applied)' };
  }
  const Lmax = cal.declared_lead_time_max_days;
  if (Number.isInteger(Lmax) && Lmax > L) {
    const dl = delayedLeadTime(D, Lmax, cal.supplier_delays);
    const aLate = plan.open(dl.lead_time_days + 2);
    if (aLate + ctx.R - 1 <= covered) {
      const s = orderSuggestion({ ...ctx, a: aLate }, start, scheduledArrivals);
      const before = simulate(start, ctx.demand, scheduledArrivals);
      c.late_delivery_scenario = {
        label: `If the order arrives at the supplier's declared slowest time (${Lmax} day(s)${dl.extra_days ? ` + ${dl.extra_days} delay` : ''})`,
        lead_time_days: dl.lead_time_days, usable_from: addDays(D, aLate - 1),
        shortage_before_usable: r2(sum(before.slice(0, aLate - 1).map(r => r.short))),
        quantity: s.quantity, raw_units: s.raw_units,
      };
    } else {
      c.late_delivery_scenario = { label: `Declared slowest time ${Lmax} day(s)`, withheld: 'The slowest delivery plus the review period reaches beyond the forecast.' };
    }
  }
  const first = rows ? rows.find(r => r.short > EPS) : null;
  if (first && result.forecast?.pattern_group !== 'rare') {
    // Latest planning day o (1-based) whose order is usable on or before the first short day.
    let o = null;
    for (let k = 1; k <= first.day; k += 1) {
      const dl = delayedLeadTime(addDays(D, k - 1), L, cal.supplier_delays);
      const usable = plan.open((k - 1) + dl.lead_time_days + 2);
      if (usable <= first.day) o = k;
    }
    c.order_by = o ? { date: addDays(D, o - 1), first_short_day: addDays(D, first.day - 1),
      text: `Order by ${addDays(D, o - 1)} so it is usable before the first projected shortage on ${addDays(D, first.day - 1)} (A1 spreading; an approximation).` }
      : { date: null, first_short_day: addDays(D, first.day - 1), text: `Even an order placed today is usable only after the first projected shortage on ${addDays(D, first.day - 1)}.` };
  }
}

function finish(result, used) {
  result.assumptions = ['A1', 'A2', 'A3', 'A4', 'C1', 'C2', 'C3'].filter(c => used.has(c)).map(code => ({ code, text: ASSUMPTIONS[code] }));
  if (result.status !== 'unavailable') {
    result.status = result.missing.length ? 'needs_information'
      : result.indicative_reasons.length ? 'indicative' : 'provisional';
  }
  if (result.suggestion && result.status !== 'provisional' && !result.suggestion_withheld) {
    result.suggestion.indicative_only = true;
  }
  result.actionable = result.status === 'provisional' && Boolean(result.suggestion) && result.suggestion.quantity > 0;
  // An unplaced order (draft, or approved but not marked ordered) for this product is not
  // incoming, so the suggestion is unchanged (R12) — but another draft is not offered:
  // the seller should finish or cancel the existing one first.
  const unplaced = [...result.incoming.drafts, ...result.incoming.approved_not_sent];
  if (result.actionable && unplaced.length) {
    result.actionable = false;
    result.draft_blocked = { code: 'unplaced_order_exists', po_ids: unplaced.map(o => o.po_id),
      text: `${unplaced.map(o => `PO-${o.po_id}`).join(', ')} for this product ${unplaced.length === 1 ? 'is' : 'are'} not placed yet. Review, place or cancel ${unplaced.length === 1 ? 'it' : 'them'} before creating another draft.` };
  }
  return result;
}

module.exports = {
  ENGINE_VERSION, ENGINE_VERSION_CALENDAR, FORECAST_MAX_LAG_DAYS, DEFAULT_REVIEW_DAYS, DEFAULT_SAFETY_STOCK, ASSUMPTIONS,
  recommend, demandGrid, simulate, minimumQuantity, supplierSteps, addDays, daysBetween, calendarPlan, delayedLeadTime,
};
