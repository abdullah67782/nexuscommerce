// Stage 3a numerical tests for the calendar path of the pure engine (replenishment-2).
// Fixed inputs → exact expected numbers. No database, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/replenishment/engine');
const { explain } = require('../lib/replenishment/explain');
const CAL = require('../lib/calendar');

const D = '2026-10-09';
const day = (n) => E.addDays(D, n);
const EMPTY = { country: null, country_confirmed: false, closures: [], demand_changes: [], promotions_without_change: [],
  supplier_delays: [], holidays: [], declared_lead_time_max_days: null, incoming_in_supplier_delay: [] };
// 2 units a day everywhere; stock 20; lead time 7 (order usable on day 9); review 7 days.
function flat(o = {}) {
  return {
    product_id: 1, planning_date: D, timezone: 'Asia/Karachi',
    stock: { state: 'last_known', on_hand: o.on_hand ?? 20, counted_at: '2026-10-08T10:00:00.000Z', count_business_date: '2026-10-08',
      count_age_days: 0, stale_after_days: 7, movement_tracking: 'declared_unverified' },
    forecast: { status: 'ok', origin: D, totals: { 7: 14, 28: 56 }, method: 'shared_model', pattern_group: 'regular', tier: 'model', usable_days: 400 },
    incoming: o.incoming ?? [],
    not_placed: { approved: [], drafts: [] },
    supplier: { state: 'ok', id: 3, name: 'Acme', source: 'preferred', lead_time_days: o.lead ?? 7, pack_size: 1, min_order_qty: 1, unit_cost: 100, currency: 'PKR' },
    policy: { review_period_days: 7, safety_stock_units: 0 },
    sales_since_count: { units_not_deducted: 0, count_day_units: 0, sources: [] },
    ...(o.calendar ? { calendar: { ...EMPTY, ...o.calendar } } : {}),
  };
}
const strip = (r) => { const x = JSON.parse(JSON.stringify(r)); delete x.engine_version; delete x.calendar; return x; };

test('without calendar entries replenishment-2 gives exactly the replenishment-1 numbers', () => {
  for (const o of [{}, { on_hand: 0 }, { on_hand: 60 }, { lead: 3 }, { incoming: [{ po_id: 5, quantity: 10, expected_arrival: day(3), status: 'ordered' }] },
    { incoming: [{ po_id: 6, quantity: 4, expected_arrival: day(-2), status: 'ordered' }] }]) {
    const v1 = E.recommend(flat(o));
    const v2 = E.recommend(flat({ ...o, calendar: {} }));
    assert.equal(v1.engine_version, 'replenishment-1');
    assert.equal(v2.engine_version, 'replenishment-2');
    assert.deepEqual(strip(v2), strip(v1), JSON.stringify(o));
  }
});

test('a demand scenario multiplies its days, is labelled, and the forecast-only quantity is shown', () => {
  // +50% on days 9..15 (the whole review window): window demand 7×3 = 21 instead of 14.
  const r = E.recommend(flat({ calendar: { demand_changes: [{ id: 11, version: 1, kind: 'demand_scenario', title: 'Eid rush', start_date: day(8), end_date: day(14), scope: 'all', demand_change_pct: 50 }] } }));
  // Stock 20 − 16 (days 1..8) = 4 at the order; window needs 21 → 17.
  assert.equal(r.suggestion.raw_units, 17);
  assert.equal(r.calendar.quantity_without_seller_scenarios.quantity, 10);
  assert.equal(r.calendar.applied[0].label, 'assumed_by_seller');
  assert.equal(r.calendar.applied[0].planning_days, 7);
  assert.ok(r.assumptions.some(a => a.code === 'C2'));
  assert.match(explain(r).find(s => s.title === 'Calendar').text, /Your assumption "Eid rush": demand \+50%.*not a prediction/);
});

test('two demand changes on one day are a conflict: no quantity, never combined silently', () => {
  const r = E.recommend(flat({ calendar: { demand_changes: [
    { id: 1, version: 1, kind: 'demand_scenario', title: 'A', start_date: day(0), end_date: day(20), scope: 'all', demand_change_pct: 20 },
    { id: 2, version: 1, kind: 'promotion', title: 'B', start_date: day(10), end_date: day(12), scope: 'products', demand_change_pct: 100 }] } }));
  assert.equal(r.status, 'needs_information');
  assert.equal(r.suggestion, null);
  assert.equal(r.suggestion_withheld.code, 'calendar_conflict');
  assert.equal(r.missing.find(m => m.code === 'calendar_conflict').conflicts.length, 3);
});

test('a closure zeroes demand and moves a delivery and the new order to the next open day', () => {
  // Closed on days 9 and 10 (dates D+8, D+9). The order (lead 7) would be usable on day 9 → day 11.
  // PO-5 expected D+7 (usable day 9) → day 11 as well.
  const r = E.recommend(flat({ incoming: [{ po_id: 5, quantity: 6, expected_arrival: day(7), status: 'ordered' }],
    calendar: { closures: [{ id: 3, version: 1, kind: 'closure', title: 'Stocktake', start_date: day(8), end_date: day(9), scope: 'all' }] } }));
  assert.equal(r.incoming.scheduled[0].usable_day, 11);
  assert.equal(r.incoming.scheduled[0].usable_from, day(10));
  assert.equal(r.before_arrival.usable_day, 11);
  // Days 1..8: 16 sold → 4 left; days 9–10 closed (no sales). Window 11..17: 14 demand − 4 − 6 incoming = 4.
  assert.equal(r.suggestion.raw_units, 4);
  assert.ok(r.assumptions.some(a => a.code === 'C1'));
});

test('a supplier delay lengthens the lead time of the new order; open orders inside it are warned, not moved', () => {
  const r = E.recommend(flat({ incoming: [{ po_id: 8, quantity: 5, expected_arrival: day(4), status: 'ordered' }],
    calendar: { supplier_delays: [{ id: 4, version: 1, kind: 'supplier_delay', title: 'Port strike', start_date: day(0), end_date: day(10), scope: 'supplier', extra_delay_days: 3 }],
      incoming_in_supplier_delay: [{ po_id: 8, expected_arrival: day(4), entry_id: 4, title: 'Port strike', extra_delay_days: 3 }] } }));
  assert.deepEqual(r.calendar.supplier_delay, { label: 'declared_by_seller', lead_time_days: 7, extra_days: 3, effective_lead_time_days: 10, entries: [4],
    text: 'Lead time 7 + 3 day(s) from the supplier delay you entered = 10 day(s).' });
  assert.equal(r.before_arrival.order_expected, day(10));
  assert.equal(r.before_arrival.usable_day, 12);
  assert.equal(r.incoming.scheduled[0].usable_day, 6, 'PO-8 keeps its date');
  assert.ok(r.warnings.some(w => w.code === 'incoming_in_supplier_delay' && w.po_id === 8));
});

test('declared slowest lead time gives a labelled late-delivery scenario; the main quantity uses the usual lead time', () => {
  const base = E.recommend(flat({ calendar: {} }));
  const r = E.recommend(flat({ calendar: { declared_lead_time_max_days: 10 } }));
  assert.equal(r.suggestion.quantity, base.suggestion.quantity);
  const s = r.calendar.late_delivery_scenario;
  assert.equal(s.lead_time_days, 10);
  assert.equal(s.usable_from, day(11));
  // Stock 20 lasts 10 days; days 11 short before day 12 → 2 units short; window 12..18 needs 14.
  assert.equal(s.shortage_before_usable, 2);
  assert.equal(s.quantity, 14);
});

test('order-by date: the latest day whose order is usable before the first projected shortage', () => {
  // Stock 30 at 2/day lasts 15 days; first short day 16. Lead 7: an order on day k is usable on day k+8 → k ≤ 8.
  const r = E.recommend(flat({ on_hand: 30, calendar: {} }));
  assert.equal(r.calendar.order_by.first_short_day, day(15));
  assert.equal(r.calendar.order_by.date, day(7));
});

test('holidays are context only: they never change the demand', () => {
  const hol = CAL.holidays('PK', D, day(27));
  const r = E.recommend(flat({ calendar: { country: 'PK', country_confirmed: true, holidays: hol } }));
  const base = E.recommend(flat({ calendar: {} }));
  assert.equal(r.suggestion.quantity, base.suggestion.quantity);
  assert.equal(r.calendar.holiday_effect, 'not_known');
});

test('calendar catalog: Eid dates are expected estimates with a ±1-day window until confirmed', () => {
  const h = CAL.holidays('PK', '2027-03-01', '2027-03-31').find(x => x.key === 'eid_al_fitr');
  assert.equal(h.status, 'expected');
  assert.equal(h.start, '2027-03-10');
  assert.deepEqual(h.possible_dates, { start: '2027-03-09', end: '2027-03-13' });
  const c = CAL.holidays('PK', '2027-03-01', '2027-03-31', [{ id: 1, country_code: 'PK', event_key: 'eid_al_fitr', year: 2027,
    confirmed_start: '2027-03-11', confirmed_end: '2027-03-13', confirmed_at: '2027-03-09T00:00:00Z' }]).find(x => x.key === 'eid_al_fitr');
  assert.equal(c.status, 'confirmed_by_seller');
  assert.equal(c.start, '2027-03-11');
  assert.equal(c.possible_dates, null);
  assert.equal(CAL.holidays('US', '2026-11-01', '2026-11-30').find(x => x.key === 'thanksgiving').start, '2026-11-26');
});

test('a locally confirmed Eid date changes the calendar input (so older recommendations become stale), and keeps "effect unknown"', () => {
  const D2 = '2027-03-01';
  const settings = { country_code: 'PK' };
  const base = CAL.forProduct({ settings, confirmations: [], entries: [] }, { id: 1, category: null }, null, D2, 28);
  const conf = [{ id: 7, country_code: 'PK', event_key: 'eid_al_fitr', year: 2027, confirmed_start: '2027-03-11', confirmed_end: '2027-03-13',
    confirmed_at: '2027-03-09T00:00:00Z' }];
  const after = CAL.forProduct({ settings, confirmations: conf, entries: [] }, { id: 1, category: null }, null, D2, 28);
  const I = require('../lib/replenishment/inputs');
  assert.notEqual(I.fingerprint({ calendar: base }), I.fingerprint({ calendar: after }));
  const eid = after.holidays.find(h => h.key === 'eid_al_fitr');
  assert.deepEqual([eid.status, eid.start, eid.effect, eid.effect_label], ['confirmed_by_seller', '2027-03-11', 'not_known', 'Effect unknown']);
  const r = E.recommend(flat({ calendar: { country: 'PK', country_confirmed: true, holidays: after.holidays } }));
  assert.equal(r.calendar.holiday_effect_label, 'Effect unknown');
  assert.equal(r.suggestion.quantity, E.recommend(flat({ calendar: {} })).suggestion.quantity, 'a holiday never changes the quantity');
});

test('labels: seller % changes are "assumed by you"; closures and delays are declared by you', () => {
  assert.equal(CAL.entryLabel({ kind: 'demand_scenario', demand_change_pct: 40 }), 'assumed_by_seller');
  assert.equal(CAL.entryLabel({ kind: 'promotion', demand_change_pct: 10 }), 'assumed_by_seller');
  assert.equal(CAL.entryLabel({ kind: 'promotion', demand_change_pct: null }), 'information_only');
  assert.equal(CAL.entryLabel({ kind: 'closure' }), 'declared_closure');
  assert.equal(CAL.entryLabel({ kind: 'supplier_delay', extra_delay_days: 3 }), 'declared_supplier_delay');
  assert.deepEqual(CAL.LABELS, { assumed_by_seller: 'Assumed by you', declared_closure: 'Closure declared by you',
    declared_supplier_delay: 'Supplier delay declared by you', information_only: 'Information only' });
  const r = E.recommend(flat({ calendar: { closures: [{ id: 3, version: 1, kind: 'closure', title: 'Stocktake', start_date: day(2), end_date: day(2), scope: 'all' }],
    demand_changes: [{ id: 4, version: 1, kind: 'demand_scenario', title: 'Rush', start_date: day(10), end_date: day(12), scope: 'all', demand_change_pct: 20 }] } }));
  assert.deepEqual(r.calendar.applied.map(x => [x.effect, x.label]), [['closure', 'declared_by_seller'], ['demand_change', 'assumed_by_seller']]);
});
