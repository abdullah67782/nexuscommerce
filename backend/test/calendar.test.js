// Stage 3a API tests: store calendar (country, holidays, local confirmations, entries), seller
// isolation, the calendar inside replenishment (replenishment-2), invalidation of older recommendations,
// the declared slowest lead time, and the switch back to replenishment-1.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm } = require('./helpers');
const { todayIn } = require('../lib/imports');
const forecastService = require('../lib/forecastService');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); delete process.env.INVENTORY_CALENDAR_ENABLED; });
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  forecastService.clearCache();
  process.env.FORECAST_V2_ENABLED = 'true';
  process.env.INVENTORY_CALENDAR_ENABLED = 'true';
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const TZ = 'Asia/Karachi';
const D = () => todayIn(TZ);
const day = (n) => new Date(Date.parse(`${D()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const key = () => crypto.randomUUID();
const one = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0];
const api = (method, path, token, json, headers) => ctx.api(method, path, { token, json, headers });

async function sales(seller, products, first = day(-40), last = day(-1)) {
  const lines = ['product_name,quantity,sale_date,revenue,category'];
  for (let d = first; d <= last; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    for (const [name, q] of Object.entries(products)) if (q > 0) lines.push(`${name},${q},${d},${q * 10},Lawn`);
  }
  const form = csvForm(lines.join('\n'));
  for (const [k, v] of Object.entries({ coverage_start: first, coverage_end: last, coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const res = await ctx.api('POST', '/data/upload', { token: seller.token, form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
const pid = async (name, seller = a) => (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, seller.id])).id;
async function ready(seller = a, name = 'Lawn Suit', terms = {}) {
  await sales(seller, { [name]: 2 });
  const id = await pid(name, seller);
  const c = await api('POST', '/inventory/snapshots', seller.token, { idempotency_key: key(), observed_at: new Date(Date.now() - 60000).toISOString(),
    items: [{ product_id: id, quantity: 20 }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const s = await api('POST', '/suppliers', seller.token, { name: 'Lahore Supplies' });
  const t = await api('PUT', `/products/${id}/suppliers/${s.body.id}`, seller.token,
    { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1, ...terms });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return { id, sup: s.body.id };
}
const entry = (token, body) => api('POST', '/calendar/entries', token, body);

test('country: suggested from the location timezone but only used once the seller confirms it', async () => {
  await ready();
  let s = await api('GET', '/calendar/settings', a.token);
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.confirmed, s.body.country_code, s.body.suggested_country], [false, null, 'PK']);
  assert.deepEqual((await api('GET', '/calendar', a.token)).body.holidays, [], 'no holidays before the country is confirmed');
  assert.equal((await api('PUT', '/calendar/settings', a.token, { country_code: 'XX' })).status, 400);
  const put = await api('PUT', '/calendar/settings', a.token, { country_code: 'pk' });
  assert.deepEqual([put.status, put.body.country_code, put.body.version], [200, 'PK', 1]);
  s = await api('GET', '/calendar/settings', a.token);
  assert.equal(s.body.confirmed, true);
  const cal = await api('GET', `/calendar?from=2027-03-01&to=2027-03-31`, a.token);
  const eid = cal.body.holidays.find(h => h.key === 'eid_al_fitr');
  assert.deepEqual([eid.status, eid.start, eid.effect], ['expected', '2027-03-10', 'not_known']);
  assert.equal((await api('GET', '/calendar/settings', b.token)).body.confirmed, false, 'per seller');
  assert.equal((await api('GET', '/calendar?from=2027-01-01&to=2028-12-31', a.token)).status, 400, 'at most 400 days');
});

test('holiday confirmation: local date recorded append-only, latest wins, other sellers unaffected', async () => {
  await api('PUT', '/calendar/settings', a.token, { country_code: 'PK' });
  await api('PUT', '/calendar/settings', b.token, { country_code: 'PK' });
  assert.equal((await api('POST', '/calendar/holidays/confirm', a.token, { event_key: 'eid_al_fitr', year: 2027, start: '2027-04-01' })).status, 400, 'too far from the expected date');
  assert.equal((await api('POST', '/calendar/holidays/confirm', a.token, { event_key: 'nope', year: 2027, start: '2027-03-11' })).status, 400);
  const c1 = await api('POST', '/calendar/holidays/confirm', a.token, { event_key: 'eid_al_fitr', year: 2027, start: '2027-03-12' });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.deepEqual([c1.body.confirmed_start, c1.body.confirmed_end], ['2027-03-12', '2027-03-14'], 'three days by default');
  await api('POST', '/calendar/holidays/confirm', a.token, { event_key: 'eid_al_fitr', year: 2027, start: '2027-03-11' });
  const mine = (await api('GET', '/calendar?from=2027-03-01&to=2027-03-31', a.token)).body.holidays.find(h => h.key === 'eid_al_fitr');
  assert.deepEqual([mine.status, mine.start, mine.possible_dates], ['confirmed_by_seller', '2027-03-11', null]);
  const theirs = (await api('GET', '/calendar?from=2027-03-01&to=2027-03-31', b.token)).body.holidays.find(h => h.key === 'eid_al_fitr');
  assert.equal(theirs.status, 'expected');
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM calendar_holiday_confirmations')).n, 2);
  await assert.rejects(ctx.pool.query('DELETE FROM calendar_holiday_confirmations'), /append-only/);
});

test('entries: validation per kind, ownership, versions and history', async () => {
  const { id, sup } = await ready();
  const other = await ready(b, 'Their Shirt');
  assert.equal((await entry(a.token, { kind: 'demand_scenario', title: 'x', start_date: day(1), end_date: day(3) })).status, 400, 'needs a %');
  assert.equal((await entry(a.token, { kind: 'closure', title: 'x', start_date: day(1), end_date: day(3), scope: 'products', scope_product_ids: [id] })).status, 400);
  assert.equal((await entry(a.token, { kind: 'supplier_delay', title: 'x', start_date: day(1), end_date: day(3), supplier_id: other.sup, extra_delay_days: 2 })).status, 404, 'another seller\'s supplier');
  assert.equal((await entry(a.token, { kind: 'promotion', title: 'x', start_date: day(1), end_date: day(3), scope: 'products', scope_product_ids: [other.id] })).status, 404, 'another seller\'s product');
  assert.equal((await entry(a.token, { kind: 'promotion', title: 'x', start_date: day(1), end_date: day(3), scope: 'category', scope_category: 'Shoes' })).status, 400);
  assert.equal((await entry(a.token, { kind: 'promotion', title: 'x', start_date: day(3), end_date: day(1) })).status, 400);
  const promo = await entry(a.token, { kind: 'promotion', title: 'Summer sale', start_date: day(1), end_date: day(3), scope: 'category', scope_category: 'lawn' });
  assert.equal(promo.status, 201, JSON.stringify(promo.body));
  assert.equal(promo.body.label, 'information_only', 'a promotion without a % is information only');
  const sc = await entry(a.token, { kind: 'demand_scenario', title: 'Eid rush', start_date: day(2), end_date: day(9), demand_change_pct: 40 });
  assert.deepEqual([sc.status, sc.body.label, sc.body.entry.scope], [201, 'assumed_by_seller', 'all']);
  const dup = await entry(a.token, { kind: 'promotion', title: 'Flash', start_date: day(5), end_date: day(6), scope: 'products', scope_product_ids: [id], demand_change_pct: 100 });
  assert.equal(dup.body.overlapping_demand_changes.length, 1, 'overlap is reported at entry time');
  const e = sc.body.entry;
  assert.equal((await api('PATCH', `/calendar/entries/${e.id}`, a.token, { title: 'Eid rush 2' })).status, 428);
  assert.equal((await api('PATCH', `/calendar/entries/${e.id}`, a.token, { title: 'Eid rush 2', version: 9 })).status, 409);
  const p = await api('PATCH', `/calendar/entries/${e.id}`, a.token, { demand_change_pct: 25, version: 1 });
  assert.deepEqual([p.status, p.body.entry.version, p.body.entry.demand_change_pct], [200, 2, 25]);
  assert.equal((await api('PATCH', `/calendar/entries/${e.id}`, a.token, { kind: 'closure', version: 2 })).status, 400);
  const cancel = await api('POST', `/calendar/entries/${e.id}/cancel`, a.token, { version: 2 });
  assert.deepEqual([cancel.status, cancel.body.entry.status], [200, 'cancelled']);
  const h = await api('GET', `/calendar/entries/${e.id}/history`, a.token);
  assert.deepEqual(h.body.events.map(x => x.event), ['created', 'updated', 'cancelled']);
  // Seller isolation.
  assert.equal((await api('GET', `/calendar/entries/${e.id}/history`, b.token)).status, 404);
  assert.equal((await api('PATCH', `/calendar/entries/${promo.body.entry.id}`, b.token, { title: 'mine', version: 1 })).status, 404);
  assert.equal((await api('POST', `/calendar/entries/${promo.body.entry.id}/cancel`, b.token, { version: 1 })).status, 404);
  assert.deepEqual((await api('GET', `/calendar?from=${D()}&to=${day(30)}`, b.token)).body.entries, []);
  const delay = await entry(a.token, { kind: 'supplier_delay', title: 'Port strike', start_date: day(0), end_date: day(10), supplier_id: sup, extra_delay_days: 3 });
  assert.deepEqual([delay.status, delay.body.entry.scope], [201, 'supplier']);
  await assert.rejects(ctx.pool.query('UPDATE calendar_entry_events SET event = $1', ['created']), /append-only/);
});

test('replenishment-2: seller scenario, closure and supplier delay change the plan; older recommendations become stale', async () => {
  const { id, sup } = await ready();
  const r0 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  assert.equal(r0.body.engine_version, 'replenishment-2');
  assert.deepEqual([r0.body.suggestion.raw_units, r0.body.suggestion.quantity], [10, 10], 'no entries: the replenishment-1 numbers');
  assert.ok(r0.body.explanation.some(s => s.title === 'Calendar'));
  // A +50% demand scenario over the review window (days 9..15).
  await entry(a.token, { kind: 'demand_scenario', title: 'Eid rush', start_date: day(8), end_date: day(14), demand_change_pct: 50 });
  const r1 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r1.body.suggestion.raw_units, 17);
  assert.equal(r1.body.calendar.quantity_without_seller_scenarios.quantity, 10);
  assert.notEqual(r1.body.inputs_sha256, r0.body.inputs_sha256, 'the calendar is part of the fingerprint');
  // A draft from the older recommendation is refused as stale.
  const stale = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: r0.body.recommendation_id, inputs_sha256: r0.body.inputs_sha256 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'recommendation_stale');
  // Supplier delay: +3 days for orders arriving in the next 10 days.
  await entry(a.token, { kind: 'supplier_delay', title: 'Port strike', start_date: day(0), end_date: day(10), supplier_id: sup, extra_delay_days: 3 });
  const r2 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.deepEqual([r2.body.calendar.supplier_delay.effective_lead_time_days, r2.body.before_arrival.order_expected], [10, day(10)]);
  // Closure on the day the order would become usable.
  await entry(a.token, { kind: 'closure', title: 'Stocktake', start_date: day(11), end_date: day(11) });
  const r3 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r3.body.before_arrival.order_usable_from, day(12));
  assert.ok(r3.body.assumptions.some(x => x.code === 'C1') && r3.body.assumptions.some(x => x.code === 'C3'));
  // Another seller's calendar never reaches this product.
  await entry(b.token, { kind: 'closure', title: 'Theirs', start_date: day(0), end_date: day(20) });
  const r4 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r4.body.inputs_sha256, r3.body.inputs_sha256);
  const logged = await one(`SELECT COUNT(DISTINCT engine_version)::int AS v, MIN(engine_version) AS e FROM replenishment_recommendations`);
  assert.deepEqual(logged, { v: 1, e: 'replenishment-2' });
});

test('stale refusal: every calendar change that reaches the plan invalidates older recommendations; unrelated ones do not', async () => {
  const { id, sup } = await ready();
  await api('PUT', '/calendar/settings', a.token, { country_code: 'PK' });
  const draft = (r) => api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: r.body.recommendation_id, inputs_sha256: r.body.inputs_sha256 });
  const rec = async () => { const r = await api('GET', `/inventory/items/${id}/replenishment`, a.token); assert.equal(r.status, 200, JSON.stringify(r.body)); return r; };
  const refused = async (older, why) => {
    const res = await draft(older);
    assert.deepEqual([res.status, res.body.error], [409, 'recommendation_stale'], why);
  };
  // Each change: the earlier recommendation is refused, the fingerprint changes, and the new one is current.
  const steps = [
    ['closure', () => entry(a.token, { kind: 'closure', title: 'Stocktake', start_date: day(3), end_date: day(3) })],
    ['supplier delay', () => entry(a.token, { kind: 'supplier_delay', title: 'Port strike', start_date: day(0), end_date: day(10), supplier_id: sup, extra_delay_days: 2 })],
    ['seller demand change', () => entry(a.token, { kind: 'demand_scenario', title: 'Sale', start_date: day(9), end_date: day(12), demand_change_pct: 30 })],
    ['country change', () => api('PUT', '/calendar/settings', a.token, { country_code: 'US' })],
  ];
  let older = await rec();
  const ids = [];
  for (const [why, change] of steps) {
    const res = await change();
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    if (res.body.entry) ids.push(res.body.entry);
    const now = await rec();
    assert.notEqual(now.body.inputs_sha256, older.body.inputs_sha256, why);
    await refused(older, why);
    older = now;
  }
  // Cancelling an entry that applies is a change too.
  const closure = ids[0];
  assert.equal((await api('POST', `/calendar/entries/${closure.id}/cancel`, a.token, { version: closure.version })).status, 200);
  const afterCancel = await rec();
  assert.notEqual(afterCancel.body.inputs_sha256, older.body.inputs_sha256);
  await refused(older, 'cancelled closure');
  // Outside the plan: an entry after the 28-day grid, and a product-scoped entry for another product, change nothing.
  await entry(a.token, { kind: 'closure', title: 'Far away', start_date: day(60), end_date: day(61) });
  await entry(a.token, { kind: 'demand_scenario', title: 'Other product', start_date: day(1), end_date: day(5), scope: 'products', scope_product_ids: [id + 999], demand_change_pct: 50 });
  const same = await rec();
  assert.equal(same.body.inputs_sha256, afterCancel.body.inputs_sha256);
  const ok = await draft(same);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('conflicting demand changes withhold the quantity; scenario endpoint labels what-if delay and demand changes', async () => {
  const { id } = await ready();
  await entry(a.token, { kind: 'demand_scenario', title: 'A', start_date: day(0), end_date: day(20), demand_change_pct: 20 });
  await entry(a.token, { kind: 'promotion', title: 'B', start_date: day(10), end_date: day(11), scope: 'products', scope_product_ids: [id], demand_change_pct: 100 });
  const r = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.deepEqual([r.body.status, r.body.suggestion, r.body.suggestion_withheld.code], ['needs_information', null, 'calendar_conflict']);
  assert.equal(r.body.actionable, false);
  const s = await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token, { demand_change_pct: 50, extra_delay_days: 2 });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual([s.body.saved, s.body.actionable], [false, false]);
  assert.equal(s.body.calendar.supplier_delay.extra_days, 2);
  assert.equal(s.body.suggestion_withheld, null, 'a what-if demand change replaces saved ones, so no conflict');
  assert.equal(s.body.calendar.applied.find(x => x.effect === 'demand_change').demand_change_pct, 50);
  assert.equal((await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token, { demand_change_pct: 2000 })).status, 400);
});

test('declared slowest lead time: validated, and shown as a labelled late-delivery scenario', async () => {
  const { id, sup } = await ready(a, 'Kurta', { lead_time_days: 7, lead_time_max_days: 10 });
  const terms = { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1 };
  assert.equal((await api('PUT', `/products/${id}/suppliers/${sup}`, a.token, { ...terms, lead_time_max_days: 5 })).status, 400, 'slowest shorter than usual');
  assert.equal((await api('PUT', `/products/${id}/suppliers/${sup}`, a.token, { ...terms, lead_time_days: null, lead_time_max_days: 9 })).status, 400, 'slowest needs the usual');
  const r = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r.body.suggestion.quantity, 10, 'the main suggestion uses the usual lead time');
  assert.deepEqual([r.body.calendar.late_delivery_scenario.lead_time_days, r.body.calendar.late_delivery_scenario.quantity], [10, 14]);
});

test('switch off: INVENTORY_CALENDAR_ENABLED=false restores replenishment-1 exactly, entries kept', async () => {
  const { id } = await ready();
  process.env.INVENTORY_CALENDAR_ENABLED = 'false';
  const v1 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  await entry(a.token, { kind: 'demand_scenario', title: 'Eid rush', start_date: day(8), end_date: day(14), demand_change_pct: 50 });
  const v1b = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.deepEqual([v1.body.engine_version, v1b.body.engine_version], ['replenishment-1', 'replenishment-1']);
  assert.equal(v1b.body.inputs_sha256, v1.body.inputs_sha256, 'calendar entries do not reach replenishment-1');
  assert.equal(v1b.body.calendar, undefined);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM calendar_entries')).n, 1, 'entries are kept');
});
