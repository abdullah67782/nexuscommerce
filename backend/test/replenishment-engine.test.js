// Stage 2 numerical acceptance tests for the pure replenishment engine.
// Fixed inputs → exact expected numbers (design §7). No database, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/replenishment/engine');
const { explain } = require('../lib/replenishment/explain');

const D = '2026-10-09';
const day = (n) => E.addDays(D, n);
const SUPPLIER = { state: 'ok', id: 3, name: 'Faisalabad Textile Mills', source: 'preferred', lead_time_days: 10,
  pack_size: 10, min_order_qty: 20, unit_cost: 2800, currency: 'PKR' };

function inputs(o = {}) {
  return {
    product_id: 1, planning_date: D, timezone: 'Asia/Karachi',
    stock: { state: 'last_known', on_hand: 55, counted_at: '2026-10-08T10:00:00.000Z', count_business_date: '2026-10-08',
      count_age_days: 0, stale_after_days: 7, movement_tracking: 'declared_unverified', ...(o.stock || {}) },
    forecast: { status: 'ok', origin: D, totals: { 7: 28, 28: 120 }, method: 'shared_model', pattern_group: 'regular',
      tier: 'model', usable_days: 400, models_release: 'nexus-v2-shared-20261008', ...(o.forecast || {}) },
    incoming: o.incoming ?? [{ po_id: 7, quantity: 30, expected_arrival: day(5), status: 'ordered' }],
    not_placed: o.not_placed || { approved: [], drafts: [] },
    supplier: o.supplier === undefined ? SUPPLIER : o.supplier && { ...SUPPLIER, ...o.supplier },
    policy: { review_period_days: 14, safety_stock_units: 10, ...(o.policy || {}) },
    sales_since_count: o.sales_since_count || { units_not_deducted: 0, count_day_units: 0, sources: [] },
  };
}
const run = (o) => E.recommend(inputs(o));
// Simple-case inputs for the delivery-timing examples: 2 units/day everywhere.
const flat = (o = {}) => inputs({
  stock: { on_hand: 20 }, forecast: { totals: { 7: 14, 28: 56 } },
  supplier: { lead_time_days: 7, pack_size: 1, min_order_qty: 1, unit_cost: 100 },
  policy: { review_period_days: 7, safety_stock_units: 0 }, ...o,
});

// Independent check of minimality by brute force on whole units: the raw quantity
// must give no shortage on every day of the window and end ≥ SS; one unit less must fail.
function verifyMinimal(inp, res) {
  const s = res.suggestion;
  const a = res.supplier.lead_time_days + 2;
  const R = res.policy.review_period_days;
  const SS = res.policy.safety_stock_units;
  const g = E.daysBetween(inp.forecast.origin, D);
  const demand = E.demandGrid(inp.forecast.totals[7], inp.forecast.totals[28], g, 'blocks');
  const arrivals = new Map();
  for (const l of inp.incoming) {
    if (l.expected_arrival && l.expected_arrival >= D) {
      const u = E.daysBetween(D, l.expected_arrival) + 2;
      arrivals.set(u, (arrivals.get(u) || 0) + l.quantity);
    }
  }
  const ok = (q) => {
    const rows = E.simulate(inp.stock.on_hand, demand, arrivals, q > 0 ? { day: a, quantity: q } : null);
    const w = rows.slice(a - 1, a + R - 1);
    return w.every(r => r.short < 1e-9) && w[w.length - 1].end + 1e-9 >= SS;
  };
  assert.ok(ok(s.raw_units), `raw ${s.raw_units} must be enough`);
  if (s.raw_units > 0) assert.ok(!ok(s.raw_units - 1), `raw ${s.raw_units - 1} must not be enough`);
  assert.ok(ok(s.quantity), 'final quantity must be enough');
}

test('R1 regular sales: outlook, shortage before arrival, MOQ/pack steps, after-order outcome', () => {
  const r = run();
  assert.equal(r.status, 'provisional');
  assert.equal(r.actionable, true);
  assert.deepEqual([r.outlook[7].demand, r.outlook[7].stock_at_end, r.outlook[7].shortage_units], [28, 57, 0]);
  assert.deepEqual([r.outlook[28].demand, r.outlook[28].stock_at_end, r.outlook[28].shortage_units], [120, 0, 35]);
  assert.equal(r.outlook.approximate_cover_days, 20);
  assert.deepEqual([r.before_arrival.order_usable_from, r.before_arrival.shortage_units], ['2026-10-20', 0]);
  const s = r.suggestion;
  assert.deepEqual([s.raw_need, s.raw_units, s.minimum_adjustment, s.pack_adjustment, s.quantity], [31.86, 32, 0, 8, 40]);
  assert.deepEqual(s.cost, { amount: 112000, currency: 'PKR' });
  assert.equal(s.binding, 'safety_stock_at_window_end');
  assert.deepEqual([s.window.start, s.window.end, s.window.days], ['2026-10-20', '2026-11-02', 14]);
  assert.deepEqual([s.after_order.shortage_in_window, s.after_order.stock_at_window_end, s.after_order.safety_stock_met], [0, 18.14, true]);
  assert.equal(s.after_order.outlook[28].shortage_units, 0);
  assert.ok(r.limitations.some(l => l.code === 'stock_last_known'));
  assert.ok(r.limitations.some(l => l.code === 'safety_stock_seller_set'));
  verifyMinimal(inputs(), r);
});

test('R2 rare sales (TSB): no cover figure, raw 2.14 → 3', () => {
  const o = { stock: { on_hand: 1 }, forecast: { totals: { 7: 0.6, 28: 2.4 }, method: 'tsb', pattern_group: 'rare' }, incoming: [],
    supplier: { pack_size: 1, min_order_qty: 1 }, policy: { safety_stock_units: 1 } };
  const r = run(o);
  assert.equal(r.status, 'provisional');
  assert.equal(r.outlook.approximate_cover_days, null);
  assert.match(r.outlook.cover_note, /occasional/);
  assert.ok(r.limitations.some(l => l.code === 'rare_sales'));
  assert.deepEqual([r.suggestion.raw_need, r.suggestion.quantity], [2.14, 3]);
  verifyMinimal(inputs(o), r);
});

test('R3 insufficient history: needs information, no demand, no quantity', () => {
  const r = run({ forecast: { status: 'insufficient', usable_days: 20 } });
  assert.equal(r.status, 'needs_information');
  const m = r.missing.find(x => x.code === 'forecast_insufficient_history');
  assert.equal(m.more_days_needed, 8);
  assert.equal(r.outlook, null);
  assert.equal(r.suggestion, null);
  assert.equal(r.stock.on_hand, 55);                       // stock facts still shown
});

test('R4 stale stock: indicative, quantity marked not actionable', () => {
  const r = run({ stock: { state: 'stale', count_age_days: 12 } });
  assert.equal(r.status, 'indicative');
  assert.equal(r.actionable, false);
  assert.equal(r.suggestion.indicative_only, true);
  assert.ok(r.indicative_reasons.some(x => x.code === 'stock_stale'));
});

test('R5 overdue and undated orders: excluded from the base, labelled alternative', () => {
  const o = { stock: { on_hand: 8 }, forecast: { totals: { 7: 14, 28: 60 } },
    incoming: [{ po_id: 4, quantity: 20, expected_arrival: day(-3), status: 'ordered' }, { po_id: 5, quantity: 10, expected_arrival: null, status: 'ordered' }],
    supplier: { lead_time_days: 7, pack_size: 6, min_order_qty: 12 }, policy: { review_period_days: 7, safety_stock_units: 0 } };
  const r = run(o);
  assert.deepEqual([r.incoming.counted_units, r.incoming.uncertain_units], [0, 30]);
  assert.equal(r.incoming.overdue[0].days_overdue, 3);
  assert.equal(r.outlook[7].shortage_units, 6);
  assert.equal(r.before_arrival.shortage_units, 8.19);
  assert.deepEqual([r.suggestion.raw_need, r.suggestion.raw_units, r.suggestion.minimum_adjustment, r.suggestion.pack_adjustment, r.suggestion.quantity],
    [15.33, 16, 0, 2, 18]);
  assert.equal(r.alternative_if_uncertain_incoming_arrives.quantity, 0);
  assert.ok(r.warnings.some(w => w.code === 'incoming_overdue' && w.po_id === 4));
  assert.ok(r.warnings.some(w => w.code === 'incoming_undated' && w.po_id === 5));
  verifyMinimal(inputs(o), r);
});

test('R6 MOQ and pack: 19 of 24 units come from the minimum', () => {
  const o = { stock: { on_hand: 10 }, forecast: { totals: { 7: 7, 28: 28 } }, incoming: [],
    supplier: { lead_time_days: 7, pack_size: 12, min_order_qty: 24 }, policy: { review_period_days: 7, safety_stock_units: 0 } };
  const r = run(o);
  assert.deepEqual([r.suggestion.raw_units, r.suggestion.minimum_adjustment, r.suggestion.after_minimum, r.suggestion.pack_adjustment, r.suggestion.quantity],
    [5, 19, 24, 0, 24]);
  const text = explain(r).find(s => s.title === 'Order quantity').text;
  assert.match(text, /19 of the 24 come from the supplier's minimum/);
  verifyMinimal(inputs(o), r);
});

test('R7 / amendment 2: a 3-day-old forecast covers all 7 upcoming days and 25 of 28; never re-dated', () => {
  const o = { forecast: { origin: day(-3) } };
  const r = run(o);
  assert.equal(r.forecast.lag_days, 3);
  assert.equal(r.status, 'indicative');                   // Q6: any positive lag is indicative
  assert.ok(r.indicative_reasons.some(x => x.code === 'forecast_lag'));
  assert.deepEqual([r.outlook[7].start, r.outlook[7].end, r.outlook[7].covered_days, r.outlook[7].complete], [D, day(6), 7, true]);
  assert.deepEqual([r.outlook[28].start, r.outlook[28].end, r.outlook[28].covered_days, r.outlook[28].label],
    [D, day(24), 25, '25 days covered (of 28)']);
  assert.equal(r.outlook[7].demand, 29.14);                // forecast days 4–10, not 1–7
  assert.deepEqual(r.forecast.blocks[0], { horizon_days: 7, start: day(-3), end: day(3), total: 28 });
  assert.deepEqual([r.suggestion.raw_need, r.suggestion.quantity, r.suggestion.indicative_only], [33, 40, true]);
  assert.equal(r.actionable, false);
  verifyMinimal(inputs(o), r);
  const far = run({ forecast: { origin: day(-3) }, supplier: { lead_time_days: 14 } });
  assert.equal(far.status, 'needs_information');
  const m = far.missing.find(x => x.code === 'horizon_beyond_forecast');
  assert.deepEqual([m.days_needed, m.covered_days], [29, 25]);
  assert.equal(far.suggestion, null);
});

test('Amendment 2: forecast starting tomorrow (lag −1) withholds the today-based outlook and quantity', () => {
  const r = run({ forecast: { origin: day(1) } });
  assert.equal(r.forecast.lag_days, -1);
  assert.equal(r.forecast.lag_state, 'starts_after_today');
  assert.equal(r.status, 'indicative');
  assert.equal(r.planning_date, D);                        // the planning date is not moved
  assert.equal(r.outlook, null);
  assert.equal(r.suggestion, null);
  assert.equal(r.before_arrival, null);
  assert.match(r.outlook_withheld.text, /forecast starts tomorrow/);
  assert.match(r.outlook_withheld.text, /today may not be finished/);
  assert.deepEqual(r.forecast.blocks.map(b => [b.start, b.end]), [[day(1), day(7)], [day(1), day(28)]]);
  assert.equal(r.actionable, false);
});

test('Q6: forecast older than the documented 7-day limit needs information', () => {
  const ok7 = run({ forecast: { origin: day(-7) }, supplier: { lead_time_days: 3 }, policy: { review_period_days: 7 } });
  assert.equal(ok7.status, 'indicative');
  assert.ok(ok7.suggestion.indicative_only);
  assert.equal(ok7.outlook[28].covered_days, 21);
  const old = run({ forecast: { origin: day(-8) } });
  assert.equal(old.status, 'needs_information');
  assert.equal(old.missing[0].code, 'forecast_too_old');
  assert.equal(old.outlook, null);
});

test('R8 lead time missing: outlook shown, no quantity', () => {
  const r = run({ supplier: { lead_time_days: null } });
  assert.equal(r.status, 'needs_information');
  assert.equal(r.missing[0].code, 'lead_time_missing');
  assert.match(r.missing[0].action, /Faisalabad Textile Mills/);
  assert.equal(r.outlook[28].shortage_units, 35);
  assert.equal(r.suggestion, null);
  assert.equal(r.before_arrival, null);
});

test('Supplier missing / choice needed', () => {
  assert.equal(run({ supplier: null }).missing[0].code, 'supplier_missing');
  const r = E.recommend({ ...inputs(), supplier: { state: 'choice_needed', active_links: 2 } });
  assert.equal(r.missing[0].code, 'supplier_choice_needed');
  assert.equal(r.suggestion, null);
});

test('R9 unknown stock: demand only; unknown is never zero', () => {
  const r = run({ stock: { state: 'unverified_only', on_hand: null, legacy_quantity: 12 } });
  assert.equal(r.status, 'needs_information');
  assert.equal(r.missing[0].code, 'stock_unverified_only');
  assert.equal(r.stock.on_hand, null);
  assert.equal(r.outlook[7].demand, 28);
  assert.equal(r.outlook[7].stock_at_end, undefined);
  assert.equal(r.suggestion, null);
});

test('R10 / amendment 3: T28 < T7 gives two independent estimates, a warning and no quantity', () => {
  const r = run({ stock: { on_hand: 20 }, forecast: { totals: { 7: 21, 28: 18 } }, incoming: [] });
  assert.equal(r.forecast.horizons_consistent, false);
  assert.equal(r.status, 'indicative');
  assert.equal(r.outlook.basis, 'independent_estimates');
  assert.deepEqual([r.outlook[7].estimate_from, r.outlook[7].daily_rate, r.outlook[7].demand, r.outlook[7].shortage_units], ['7_day_forecast', 3, 21, 1]);
  assert.deepEqual([r.outlook[28].estimate_from, r.outlook[28].daily_rate, r.outlook[28].demand, r.outlook[28].shortage_units], ['28_day_forecast', 0.64, 18, 0]);
  assert.equal(r.suggestion, null);
  assert.equal(r.before_arrival, null);
  assert.equal(r.suggestion_withheld.code, 'forecast_horizons_inconsistent');
  assert.ok(r.warnings.some(w => w.code === 'forecast_horizons_inconsistent'));
});

test('R11 zero demand: no cover figure; order only for safety stock', () => {
  const o = { stock: { on_hand: 4 }, forecast: { totals: { 7: 0, 28: 0 } }, incoming: [], policy: { review_period_days: 7, safety_stock_units: 2 } };
  const r = run(o);
  assert.equal(r.outlook.approximate_cover_days, null);
  assert.ok(r.limitations.some(l => l.code === 'zero_demand' && /does not mean stock lasts forever/.test(l.text)));
  assert.equal(r.suggestion.quantity, 0);
  assert.equal(r.actionable, false);                      // provisional, but nothing to order
  const low = run({ ...o, policy: { review_period_days: 7, safety_stock_units: 6 }, supplier: { pack_size: 1, min_order_qty: 1 } });
  assert.deepEqual([low.suggestion.binding, low.suggestion.quantity], ['safety_stock_at_window_end', 2]);
});

test('R12 approved but not sent: not incoming, warned', () => {
  const r = run({ not_placed: { approved: [{ po_id: 9, quantity: 40 }], drafts: [{ po_id: 10, quantity: 5 }] } });
  assert.equal(r.suggestion.quantity, 40);
  assert.equal(r.status, 'provisional');
  assert.equal(r.actionable, false, 'no second draft while an unplaced order exists');
  assert.deepEqual(r.draft_blocked.po_ids, [10, 9]);
  assert.ok(r.warnings.some(w => w.code === 'approved_not_sent' && /avoid ordering twice/.test(w.text)));
  assert.ok(r.warnings.some(w => w.code === 'draft_open' && w.po_id === 10));
});

test('R13 sales since the count: labelled scenario, measured stock unchanged', () => {
  const r = run({ sales_since_count: { units_not_deducted: 12, count_day_units: 3, sources: [] } });
  assert.equal(r.stock.on_hand, 55);
  assert.equal(r.suggestion.quantity, 40);
  const x = r.sales_adjusted_scenario;
  assert.equal(x.starting_stock, 43);
  assert.match(x.label, /12 unit\(s\) sold since the count/);
  assert.deepEqual([x.raw_need, x.raw_units, x.quantity], [43.86, 44, 50]);
});

test('R14 forecast service down: unavailable, no forecast numbers', () => {
  const r = run({ forecast: { status: 'unavailable', message: 'down' } });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.outlook, null);
  assert.equal(r.suggestion, null);
  assert.equal(r.forecast.totals, undefined);
  assert.equal(r.stock.on_hand, 55);
  assert.equal(r.incoming.counted_units, 30);
});

// ── Amendment 1: order quantity respects delivery timing ───────────────────
// Flat demand 2/day; 20 in stock; lead time 7 → order usable on day 9 (D+8); window
// days 9–15; stock when the order is usable = 4. An existing delivery of 10 units:
test('Amendment 1: existing delivery usable on the FIRST day of the window → 0', () => {
  const o = { incoming: [{ po_id: 21, quantity: 10, expected_arrival: day(7), status: 'ordered' }] };
  const r = E.recommend(flat(o));
  assert.equal(r.suggestion.stock_when_order_usable, 4);
  assert.deepEqual([r.suggestion.window.start, r.suggestion.window.end], [day(8), day(14)]);
  assert.deepEqual([r.suggestion.raw_need, r.suggestion.quantity, r.suggestion.binding], [0, 0, 'none']);
  verifyMinimal(flat(o), r);
});

test('Amendment 1: delivery usable MIDWAY (day 4 of 7) → 2, not 0', () => {
  const o = { incoming: [{ po_id: 22, quantity: 10, expected_arrival: day(10), status: 'ordered' }] };
  const r = E.recommend(flat(o));
  const s = r.suggestion;
  // The old end-of-window balance (14 − 4 − 10 = 0) would miss the gap before PO-22 arrives.
  assert.deepEqual([s.demand_in_window, s.incoming_in_window], [14, 10]);
  assert.deepEqual([s.raw_need, s.quantity, s.binding], [2, 2, 'shortage_inside_window']);
  assert.deepEqual(s.binding_detail, { kind: 'before_delivery', delivery_usable_from: day(11), po_ids: [22] });
  assert.deepEqual([s.after_order.shortage_in_window, s.after_order.lowest_stock_in_window, s.after_order.stock_at_window_end], [0, 0, 2]);
  assert.match(explain(r).find(x => x.title === 'Order quantity').text, /run out before PO-22 becomes usable/);
  verifyMinimal(flat(o), r);
  // with safety stock 5 the window end binds instead
  const ss = E.recommend(flat({ ...o, policy: { review_period_days: 7, safety_stock_units: 5 } }));
  assert.deepEqual([ss.suggestion.quantity, ss.suggestion.binding, ss.suggestion.after_order.stock_at_window_end], [5, 'safety_stock_at_window_end', 5]);
});

test('Amendment 1: delivery usable on the LAST day of the window → 8', () => {
  const o = { incoming: [{ po_id: 23, quantity: 10, expected_arrival: day(13), status: 'ordered' }] };
  const r = E.recommend(flat(o));
  const s = r.suggestion;
  assert.deepEqual([s.raw_need, s.quantity, s.binding], [8, 8, 'shortage_inside_window']);
  assert.deepEqual([s.after_order.shortage_in_window, s.after_order.lowest_stock_in_window, s.after_order.stock_at_window_end], [0, 0, 8]);
  verifyMinimal(flat(o), r);
  // packs of 6: 8 → 12, and the after-order projection uses 12
  const pk = E.recommend(flat({ ...o, supplier: { lead_time_days: 7, pack_size: 6, min_order_qty: 1 } }));
  assert.deepEqual([pk.suggestion.raw_units, pk.suggestion.pack_adjustment, pk.suggestion.quantity, pk.suggestion.after_order.stock_at_window_end], [8, 4, 12, 12]);
  // safety stock 5 does not bind: the gap before the delivery (8) is larger
  const ss = E.recommend(flat({ ...o, policy: { review_period_days: 7, safety_stock_units: 5 } }));
  assert.deepEqual([ss.suggestion.quantity, ss.suggestion.binding], [8, 'shortage_inside_window']);
});

test('Amendment 1: shortage before arrival stays separate from the order quantity', () => {
  const o = { stock: { on_hand: 6 }, incoming: [] };
  const r = E.recommend(flat(o));
  assert.equal(r.before_arrival.shortage_units, 10);     // days 1–8 need 16, only 6 in stock
  assert.equal(r.suggestion.stock_when_order_usable, 0);
  assert.equal(r.suggestion.quantity, 14);                // the window only (7 × 2), not the lost 10
  assert.equal(r.suggestion.after_order.shortage_before_usable, 10);
  verifyMinimal(flat(o), r);
});

test('Minimality holds on many generated cases (every daily checkpoint)', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i += 1) {
    const t7 = Math.round(rnd() * 60 * 100) / 100;
    const t28 = Math.round((t7 + rnd() * 200) * 100) / 100;
    const incoming = Array.from({ length: Math.floor(rnd() * 4) }, (_, j) => ({
      po_id: 100 + j, quantity: 1 + Math.floor(rnd() * 40), expected_arrival: day(Math.floor(rnd() * 22)), status: 'ordered' }));
    const o = { stock: { on_hand: Math.floor(rnd() * 80) }, forecast: { totals: { 7: t7, 28: t28 }, origin: day(-Math.floor(rnd() * 4)) },
      incoming, supplier: { lead_time_days: Math.floor(rnd() * 10), pack_size: 1 + Math.floor(rnd() * 6), min_order_qty: 1 },
      policy: { review_period_days: 1 + Math.floor(rnd() * 12), safety_stock_units: Math.floor(rnd() * 10) } };
    const r = run(o);
    if (r.suggestion) verifyMinimal(inputs(o), r);
  }
});

test('Defaults: review period 7 labelled default; no safety stock disclosed', () => {
  const r = run({ policy: { review_period_days: null, safety_stock_units: null } });
  assert.deepEqual([r.policy.review_period_days, r.policy.review_period_source, r.policy.safety_stock_units, r.policy.safety_stock_source],
    [7, 'default', 0, 'default']);
  assert.ok(r.limitations.some(l => l.code === 'review_period_default'));
  assert.ok(r.limitations.some(l => l.code === 'no_safety_stock'));
});

test('Determinism and explanation order', () => {
  assert.deepEqual(run(), run());
  const steps = explain(run()).map(s => s.title);
  assert.deepEqual(steps, ['Stock', 'Forecast', 'Outlook', 'Incoming orders', 'Before a new order arrives', 'Order quantity', 'Assumptions']);
});

test('Review fix 1: unresolved stock reconciliation makes the result indicative (no draft)', () => {
  const recon = { state: 'needs_review', same_instant_events: 1, events_without_count: 0,
    events: [{ movement_id: 9, kind: 'damage', quantity: -2, source_id: null, effective_at: '2026-10-08T10:00:00.000Z' }] };
  const r = run({ stock: { reconciliation: recon } });
  assert.equal(r.status, 'indicative');
  assert.equal(r.actionable, false);
  assert.equal(r.suggestion.indicative_only, true);
  const reason = r.indicative_reasons.find(x => x.code === 'stock_needs_reconciliation');
  assert.deepEqual(reason.events.map(e => [e.kind, e.quantity]), [['damage', -2]]);
  assert.ok(r.warnings.some(w => w.code === 'stock_needs_reconciliation' && /damage -2/.test(w.text)));
  assert.deepEqual(r.stock.reconciliation, recon);
  const clean = run({ stock: { reconciliation: { state: 'none', same_instant_events: 0, events_without_count: 0, events: [] } } });
  assert.deepEqual([clean.status, clean.actionable], ['provisional', true]);
});

test('Review fix 2: sales timezone different from the stock location withholds projection and quantity', () => {
  const r = run({ forecast: { source_timezones: ['America/Los_Angeles'] } });
  assert.equal(r.status, 'needs_information');
  const m = r.missing.find(x => x.code === 'timezone_mismatch');
  assert.deepEqual([m.sales_timezones, m.location_timezone], [['America/Los_Angeles'], 'Asia/Karachi']);
  assert.deepEqual([r.outlook, r.before_arrival, r.suggestion, r.actionable], [null, null, null, false]);
  assert.equal(r.outlook_withheld.code, 'timezone_mismatch');
  assert.equal(r.suggestion_withheld.code, 'timezone_mismatch');
  // Facts kept, separately labelled.
  assert.deepEqual([r.stock.on_hand, r.forecast.totals[7], r.forecast.totals[28], r.forecast.dates_timezone], [55, 28, 120, 'America/Los_Angeles']);
  assert.deepEqual([r.forecast.lag_days, r.forecast.lag_state], [null, 'not_comparable']);
  assert.equal(r.incoming.counted_units, 30);
  const same = run({ forecast: { source_timezones: ['Asia/Karachi'] } });
  assert.deepEqual([same.status, same.actionable, same.forecast.dates_timezone], ['provisional', true, 'Asia/Karachi']);
  const mixed = run({ forecast: { source_timezones: ['America/Los_Angeles', 'Asia/Karachi'] } });
  assert.equal(mixed.missing[0].code, 'timezone_mismatch', 'one foreign source is enough');
});

test('Alternative delivery label says "usable tomorrow", matching its calculation', () => {
  const r = run({ incoming: [{ po_id: 4, quantity: 20, expected_arrival: day(-3), status: 'ordered' }] });
  assert.match(r.alternative_if_uncertain_incoming_arrives.label, /are usable tomorrow/);
});
