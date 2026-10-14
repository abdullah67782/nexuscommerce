// Stage 2 API tests: replenishment queue, product result, scenarios, the
// recommendation log, settings, and draft-from-recommendation consistency.
// The ML stub returns T7 = 7 × mean, T28 = 28 × mean of the last 28 days.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm } = require('./helpers');
const { todayIn } = require('../lib/imports');
const forecastService = require('../lib/forecastService');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  forecastService.clearCache();
  process.env.FORECAST_V2_ENABLED = 'true';
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const TZ = 'Asia/Karachi';
const D = () => todayIn(TZ);
const day = (n) => new Date(Date.parse(`${D()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const key = () => crypto.randomUUID();
const one = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0];
const api = (method, path, token, json) => ctx.api(method, path, { token, json });

// Sales for `products` (name → units per day) on days [first, last], coverage confirmed.
async function sales(seller, products, first = day(-40), last = day(-1)) {
  const lines = ['product_name,quantity,sale_date,revenue'];
  for (let d = first; d <= last; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
    for (const [name, q] of Object.entries(products)) if (q > 0) lines.push(`${name},${q},${d},${q * 10}`);
  }
  const form = csvForm(lines.join('\n'));
  for (const [k, v] of Object.entries({ coverage_start: first, coverage_end: last, coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const res = await ctx.api('POST', '/data/upload', { token: seller.token, form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
const pid = async (name, seller = a) => (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, seller.id])).id;
const count = (seller, items, observedAt = new Date(Date.now() - 60000).toISOString()) =>
  api('POST', '/inventory/snapshots', seller.token, { idempotency_key: key(), observed_at: observedAt, items });
async function supplier(seller, productId, terms = {}, name = 'Lahore Supplies') {
  let s = await api('POST', '/suppliers', seller.token, { name });
  if (s.status !== 201) s = { body: (await api('GET', '/suppliers', seller.token)).body.suppliers.find(x => x.name === name) };
  const t = await api('PUT', `/products/${productId}/suppliers/${s.body.id}`, seller.token,
    { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1, ...terms });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return s.body.id;
}
// One ready product: 2 units/day for 40 confirmed days, 20 counted, lead time 7.
async function ready(name = 'Lawn Suit', stock = 20, terms = {}) {
  await sales(a, { [name]: 2 });
  const id = await pid(name);
  assert.equal((await count(a, [{ product_id: id, quantity: stock }])).status, 201);
  const sup = await supplier(a, id, terms);
  return { id, sup };
}
// Content of every table Stage 2 must never change (md5 of all rows, ordered).
const TABLES = ['stock_snapshot_batches', 'stock_snapshots', 'stock_movements', 'inventory_policies', 'suppliers', 'product_suppliers',
  'purchase_orders', 'purchase_order_lines', 'purchase_order_events', 'purchase_receipts', 'sales', 'products', 'data_coverage'];
async function contents(tables = TABLES) {
  const out = {};
  for (const t of tables) out[t] = (await one(`SELECT md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).h;
  return out;
}

test('product result: provisional quantity from the daily check, logged once per identical inputs', async () => {
  const { id } = await ready();
  const r = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = r.body;
  assert.equal(x.status, 'provisional');
  assert.equal(x.planning_date, D());
  assert.deepEqual([x.forecast.lag_days, x.forecast.totals[7], x.forecast.totals[28]], [0, 14, 56]);
  assert.deepEqual([x.outlook[7].start, x.outlook[7].end, x.outlook[7].covered_days], [D(), day(6), 7]);
  assert.deepEqual([x.outlook[28].end, x.outlook[28].covered_days], [day(27), 28]);
  // 20 − 8 days × 2 = 4 when the order is usable (day 9); window 7 × 2 = 14 → 10.
  assert.deepEqual([x.before_arrival.order_usable_from, x.before_arrival.shortage_units], [day(8), 0]);
  assert.deepEqual([x.suggestion.stock_when_order_usable, x.suggestion.raw_units, x.suggestion.quantity], [4, 10, 10]);
  assert.equal(x.actionable, true);
  assert.equal(x.policy.review_period_source, 'default');
  assert.ok(x.explanation.length >= 6);
  assert.match(x.inputs_sha256, /^[0-9a-f]{64}$/);
  const again = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(again.body.recommendation_id, x.recommendation_id, 'identical inputs: same log row');
  const logged = await one('SELECT COUNT(*)::int AS n, MIN(engine_version) AS v, MIN(inputs_sha256) AS s, BOOL_AND(actionable) AS act FROM replenishment_recommendations');
  assert.deepEqual(logged, { n: 1, v: 'replenishment-1', s: x.inputs_sha256, act: true });
  const row = await one('SELECT inputs FROM replenishment_recommendations');
  assert.equal(row.inputs.engine_version, 'replenishment-1', 'the engine version is part of the fingerprinted inputs');
  assert.ok(row.inputs.forecast.history_fingerprint, 'the forecast input (history) is fingerprinted');
});

test('queue: counts across all products, filters, search, ordering and seller isolation', async () => {
  await sales(a, { 'Lawn Suit': 2, 'Kurta': 1, 'Shawl': 3 });
  const lawn = await pid('Lawn Suit');
  const kurta = await pid('Kurta');
  await count(a, [{ product_id: lawn, quantity: 20 }, { product_id: kurta, quantity: 100 }]);
  await supplier(a, lawn);
  await supplier(a, kurta);
  await sales(b, { 'Their Product': 5 });
  const q = await api('GET', '/inventory/replenishment', a.token);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.deepEqual(q.body.counts, { total: 3, needs_information: 1, shortage_before_arrival: 0, shortage_within_7: 0,
    order_suggested: 1, indicative: 0, provisional: 2, unavailable: 0 });
  assert.deepEqual(q.body.items.map(i => [i.product.name, i.status, i.suggested_quantity]),
    [['Lawn Suit', 'provisional', 10], ['Shawl', 'needs_information', null], ['Kurta', 'provisional', 0]]);
  assert.equal(q.body.items[1].next_step, 'Record a stock count.');
  const f = await api('GET', '/inventory/replenishment?state=order_suggested', a.token);
  assert.deepEqual(f.body.items.map(i => i.product.name), ['Lawn Suit']);
  assert.equal(f.body.counts.total, 3, 'counts stay across all products when filtered');
  assert.deepEqual((await api('GET', '/inventory/replenishment?q=kur', a.token)).body.items.map(i => i.product.name), ['Kurta']);
  assert.equal((await api('GET', '/inventory/replenishment?state=bogus', a.token)).status, 400);
  const theirs = await api('GET', '/inventory/replenishment', b.token);
  assert.deepEqual(theirs.body.items.map(i => i.product.name), ['Their Product']);
  assert.equal((await api('GET', `/inventory/items/${lawn}/replenishment`, b.token)).status, 404);
  assert.equal((await api('POST', `/inventory/items/${lawn}/replenishment/scenario`, b.token, { review_period_days: 14 })).status, 404);
});

test('non-mutation: queue, product result and scenario leave every stock, order, setting and sales row unchanged', async () => {
  const { id } = await ready();
  await api('PATCH', `/inventory/items/${id}/policy`, a.token, { safety_stock_units: 2 });
  const beforeAll = await contents();
  await api('GET', '/inventory/replenishment', a.token);
  await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  const logBefore = await contents(['replenishment_recommendations']);
  const s = await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token,
    { review_period_days: 14, safety_stock_units: 9, lead_time_days: 3, include_uncertain_incoming: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(await contents(), beforeAll, 'table contents identical, not just row counts');
  assert.deepEqual(await contents(['replenishment_recommendations']), logBefore, 'a scenario is not logged');
});

test('scenario: labelled, not saved, settings unchanged, never actionable', async () => {
  const { id } = await ready();
  const s = await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token, { review_period_days: 14 });
  assert.equal(s.body.label, 'Scenario — not saved');
  assert.equal(s.body.saved, false);
  assert.equal(s.body.policy.review_period_source, 'scenario');
  assert.equal(s.body.suggestion.quantity, 24);             // window 14 × 2 − 4
  assert.equal(s.body.actionable, false);
  assert.equal(s.body.recommendation_id, undefined);
  const pol = await api('GET', `/inventory/items/${id}/policy`, a.token);
  assert.deepEqual([pol.body.effective.review_period_days, pol.body.effective.review_period_source], [7, 'default']);
  assert.equal((await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token, { review_period_days: 40 })).status, 400);
  assert.equal((await api('POST', `/inventory/items/${id}/replenishment/scenario`, a.token, {})).status, 400);
});

test('settings: review period and safety stock per product and seller default', async () => {
  const { id } = await ready();
  assert.equal((await api('PATCH', '/inventory/policy', a.token, { review_period_days: 14 })).status, 200);
  let x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.policy.review_period_days, x.policy.review_period_source], [14, 'seller_default']);
  const p = await api('PATCH', `/inventory/items/${id}/policy`, a.token, { review_period_days: 10, safety_stock_units: 3 });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.effective.review_period_days, p.body.effective.safety_stock_units, p.body.effective.review_period_source], [10, 3, 'product']);
  x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.policy.review_period_days, x.policy.safety_stock_units, x.suggestion.quantity], [10, 3, 19]);   // 20 + 3 − 4
  assert.equal((await api('PATCH', `/inventory/items/${id}/policy`, a.token, { review_period_days: 29 })).status, 400);
  assert.equal((await api('PATCH', `/inventory/items/${id}/policy`, a.token, { safety_stock_units: -1 })).status, 400);
  assert.equal((await api('PATCH', `/inventory/items/${id}/policy`, a.token, { stale_after_days: 9 })).body.effective.safety_stock_units, 3,
    'changing one setting keeps the others');
});

test('draft from recommendation: draft only, idempotent retry, link recorded, Stage 1b rules still apply', async () => {
  const { id, sup } = await ready('Lawn Suit', 20, { pack_size: 6, min_order_qty: 12 });
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.suggestion.raw_units, x.suggestion.minimum_adjustment, x.suggestion.quantity], [10, 2, 12]);
  const body = { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 };
  const first = await api('POST', '/purchase-orders/from-recommendation', a.token, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const po = first.body.purchase_order;
  assert.deepEqual([po.status, po.supplier_id ?? po.supplier?.id, po.lines[0].product_id, po.lines[0].quantity_ordered ?? po.lines[0].quantity],
    ['draft', sup, id, 12]);
  assert.equal((await one('SELECT source_recommendation_id AS r FROM purchase_orders WHERE id = $1', [po.id])).r, x.recommendation_id);
  const retry = await api('POST', '/purchase-orders/from-recommendation', a.token, body);
  assert.deepEqual([retry.status, retry.body.replayed, retry.body.purchase_order.id], [200, true, po.id]);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_orders')).n, 1);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM stock_movements')).n, 0, 'no stock effect');
  // The draft is now an unplaced order: the next result warns and changes its fingerprint.
  const next = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.notEqual(next.inputs_sha256, x.inputs_sha256);
  assert.ok(next.warnings.some(w => w.code === 'draft_open' && w.po_id === po.id));
  assert.deepEqual([next.status, next.actionable, next.draft_blocked.code], ['provisional', false, 'unplaced_order_exists']);
  const again = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: next.recommendation_id, inputs_sha256: next.inputs_sha256 });
  assert.deepEqual([again.status, again.body.error], [409, 'not_actionable'], 'no second draft from the recomputed result');
  // Another seller cannot use it.
  assert.equal((await api('POST', '/purchase-orders/from-recommendation', b.token, body)).status, 404);
  // Cancelling the draft frees the recommendation: identical inputs, a new draft is allowed.
  const cancelled = await api('POST', `/purchase-orders/${po.id}/cancel`, a.token, { version: po.version, reason: 'test: wrong supplier' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const freed = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([freed.recommendation_id, freed.actionable, freed.draft_order], [x.recommendation_id, true, null], 'same inputs, same recommendation');
  const second = await api('POST', '/purchase-orders/from-recommendation', a.token, body);
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.purchase_order.id, po.id);
  const linked = await ctx.pool.query('SELECT status FROM purchase_orders WHERE source_recommendation_id = $1 ORDER BY id', [x.recommendation_id]);
  assert.deepEqual(linked.rows.map(r => r.status), ['cancelled', 'draft']);
  const po2 = second.body.purchase_order;
  // Approval still runs the Stage 1b checks (12 is a multiple of 6 and ≥ MOQ 12).
  const ap = await api('POST', `/purchase-orders/${po2.id}/approve`, a.token, { version: po2.version });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
});

test('draft from recommendation: concurrent requests create exactly one draft', async () => {
  const { id } = await ready();
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  const body = { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 };
  const results = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/purchase-orders/from-recommendation', a.token, body)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(r => r.body.purchase_order.id)).size, 1);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE source_recommendation_id = $1', [x.recommendation_id])).n, 1);
});

test('draft from recommendation: refused when any input changed since (stock, supplier terms, sales); nothing created', async () => {
  const { id, sup } = await ready();
  const check = async (change, what) => {
    const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
    assert.equal(x.actionable, true, what);
    await change();
    const before = await contents(['purchase_orders', 'purchase_order_lines']);
    const r = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
    assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.error, 'recommendation_stale');
    assert.ok(r.body.current.recommendation_id && r.body.current.recommendation_id !== x.recommendation_id, `${what}: recomputed result returned`);
    assert.notEqual(r.body.current.inputs_sha256, x.inputs_sha256);
    assert.deepEqual(await contents(['purchase_orders', 'purchase_order_lines']), before, `${what}: no order`);
  };
  await check(() => count(a, [{ product_id: id, quantity: 15 }]), 'new count');
  await check(() => api('PUT', `/products/${id}/suppliers/${sup}`, a.token, { unit_cost: 100, currency: 'PKR', lead_time_days: 5, min_order_qty: 1, pack_size: 1 }), 'lead time');
  await check(() => api('PATCH', `/inventory/items/${id}/policy`, a.token, { safety_stock_units: 4 }), 'safety stock');
  await check(() => sales(a, { 'Lawn Suit': 9 }, day(0), day(0)), 'sales history (today confirmed)');
  const bad = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: 999999, inputs_sha256: 'a'.repeat(64) });
  assert.equal(bad.status, 404);
});

test('draft from recommendation: only provisional results with a quantity', async () => {
  await sales(a, { 'No Supplier': 2 });
  const id = await pid('No Supplier');
  await count(a, [{ product_id: id, quantity: 5 }]);
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(x.status, 'needs_information');
  assert.equal(x.missing[0].code, 'supplier_missing');
  const r = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
  assert.deepEqual([r.status, r.body.error], [409, 'not_actionable']);
  const mismatch = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: 'b'.repeat(64) });
  assert.deepEqual([mismatch.status, mismatch.body.error], [409, 'recommendation_mismatch']);
});

test('forecast 3 days behind: indicative, 25 of 28 days covered, not actionable', async () => {
  await sales(a, { 'Old Data': 2 }, day(-43), day(-4));
  const id = await pid('Old Data');
  await count(a, [{ product_id: id, quantity: 20 }]);
  await supplier(a, id);
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.status, x.forecast.lag_days, x.forecast.origin], ['indicative', 3, day(-3)]);
  assert.deepEqual([x.outlook[7].covered_days, x.outlook[28].covered_days, x.outlook[28].label], [7, 25, '25 days covered (of 28)']);
  assert.equal(x.actionable, false);
  assert.equal(x.suggestion.indicative_only, true);
  const r = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
  assert.equal(r.status, 409);
});

test('sales since the count from a file without a shipment feed: labelled scenario, count-day ambiguous', async () => {
  await sales(a, { 'Lawn Suit': 2 }, day(-40), day(-4));
  const id = await pid('Lawn Suit');
  // Count during day −3 (Karachi noon); then sales for days −3, −2, −1 arrive in a file.
  const noon = new Date(Date.parse(`${day(-3)}T07:00:00Z`)).toISOString();
  await count(a, [{ product_id: id, quantity: 30 }], noon);
  await supplier(a, id);
  await sales(a, { 'Lawn Suit': 2 }, day(-3), day(-1));
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(x.stock.on_hand, 30, 'measured stock is not altered');
  assert.deepEqual([x.sales_since_count.units_not_deducted, x.sales_since_count.count_day_units], [4, 2]);
  assert.equal(x.sales_since_count.sources[0].uncovered_units, 4);
  assert.equal(x.sales_adjusted_scenario.starting_stock, 26);
  assert.match(x.sales_adjusted_scenario.label, /4 unit\(s\) sold since the count/);
});

test('forecast service down or switched off: unavailable, no numbers, not logged', async () => {
  const { id } = await ready();
  ctx.ml.override = (c) => (c.url === '/v2/forecast' ? { status: 503, body: { detail: 'v2 models unavailable' } } : null);
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(x.status, 'unavailable');
  assert.equal(x.outlook, null);
  assert.equal(x.suggestion, null);
  assert.equal(x.recommendation_id, null);
  assert.equal(x.stock.on_hand, 20, 'stock facts still shown');
  const q = (await api('GET', '/inventory/replenishment', a.token)).body;
  assert.deepEqual([q.forecast_service, q.counts.unavailable], ['unavailable', 1]);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM replenishment_recommendations')).n, 0);
  ctx.ml.reset();
  delete process.env.FORECAST_V2_ENABLED;
  const off = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(off.status, 'unavailable');
  assert.match(off.forecast.message, /switched off/);
});

test('rolling back a sales upload keeps a product that has logged recommendations', async () => {
  const up = await sales(a, { 'Short Lived': 2 });
  const id = await pid('Short Lived');
  await api('PATCH', '/inventory/policy', a.token, { review_period_days: 7 });   // creates the location; no product reference
  await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM replenishment_recommendations')).n, 1);
  const rb = await api('POST', `/data/rollback/${up.upload_id}`, a.token);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM products WHERE id = $1', [id])).n, 1);
});

test('sales confirmed through today: forecast starts tomorrow, today-based outlook and quantity withheld', async () => {
  await sales(a, { 'Up To Date': 2 }, day(-40), day(0));
  const id = await pid('Up To Date');
  await count(a, [{ product_id: id, quantity: 20 }]);
  await supplier(a, id);
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.status, x.planning_date, x.forecast.origin, x.forecast.lag_days], ['indicative', D(), day(1), -1]);
  assert.deepEqual([x.outlook, x.suggestion, x.actionable], [null, null, false]);
  assert.equal(x.outlook_withheld.code, 'forecast_starts_after_today');
  assert.match(x.outlook_withheld.text, /today may not be finished/);
  assert.deepEqual(x.forecast.blocks.map(bk => bk.start), [day(1), day(1)]);
});

test('Review fix 1: a movement at the count instant makes the result indicative and refuses the older recommendation', async () => {
  const { id } = await ready();
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(x.actionable, true);
  assert.equal(x.stock.reconciliation.state, 'none');
  const countedAt = (await api('GET', `/inventory/items/${id}`, a.token)).body.stock.last_count.observed_at;
  const mv = await api('POST', '/inventory/movements', a.token,
    { idempotency_key: key(), kind: 'damage', product_id: id, quantity: 2, reason: 'broken at count time', effective_at: countedAt });
  assert.equal(mv.status, 201, JSON.stringify(mv.body));
  const item = (await api('GET', `/inventory/items/${id}`, a.token)).body;
  assert.equal(item.readiness.reconciliation.state, 'needs_review', 'the Stock tab reports it');
  assert.equal(item.stock.on_hand, 20, 'treated as inside the count, so on-hand alone does not change');
  const y = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([y.status, y.actionable, y.suggestion.indicative_only], ['indicative', false, true]);
  assert.notEqual(y.inputs_sha256, x.inputs_sha256, 'the new ambiguity changes the fingerprint');
  assert.deepEqual(y.stock.reconciliation.events.map(e => [e.kind, e.quantity]), [['damage', -2]]);
  const q = (await api('GET', '/inventory/replenishment', a.token)).body;
  assert.equal(q.items[0].next_step, 'Check the movements at the count time, or recount.');
  const before = await contents(['purchase_orders', 'purchase_order_lines']);
  const old = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
  assert.deepEqual([old.status, old.body.error, old.body.current?.status], [409, 'recommendation_stale', 'indicative'], 'older actionable recommendation refused');
  const now = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: y.recommendation_id, inputs_sha256: y.inputs_sha256 });
  assert.deepEqual([now.status, now.body.error], [409, 'not_actionable']);
  assert.deepEqual(await contents(['purchase_orders', 'purchase_order_lines']), before, 'no draft created');
  // A new count resolves it: actionable again.
  await count(a, [{ product_id: id, quantity: 18 }]);
  const z = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([z.status, z.actionable, z.stock.reconciliation.state], ['provisional', true, 'none']);
});

test('Review fix 2: sales in America/Los_Angeles, stock in Asia/Karachi → needs information, facts kept, older recommendation refused', async () => {
  const { id } = await ready();
  const x = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.deepEqual([x.actionable, x.forecast.dates_timezone], [true, TZ]);
  const src = (await api('GET', '/data/sources', a.token)).body.sources[0];
  assert.equal((await api('PATCH', `/data/sources/${src.id}`, a.token, { timezone: 'America/Los_Angeles' })).status, 200);
  const y = (await api('GET', `/inventory/items/${id}/replenishment`, a.token)).body;
  assert.equal(y.status, 'needs_information');
  assert.equal(y.missing[0].code, 'timezone_mismatch');
  assert.match(y.missing[0].action, /America\/Los_Angeles.*Asia\/Karachi/);
  assert.deepEqual([y.outlook, y.before_arrival, y.suggestion, y.actionable], [null, null, null, false]);
  assert.deepEqual([y.stock.on_hand, y.forecast.totals[7], y.forecast.totals[28], y.forecast.dates_timezone], [20, 14, 56, 'America/Los_Angeles']);
  const q = (await api('GET', '/inventory/replenishment', a.token)).body;
  assert.deepEqual([q.counts.order_suggested, q.counts.needs_information], [0, 1]);
  const old = await api('POST', '/purchase-orders/from-recommendation', a.token, { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
  assert.deepEqual([old.status, old.body.error], [409, 'recommendation_stale']);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_orders')).n, 0);
});
