// The complete seller journey through the Inventory AI module, end to end on the API:
// upload + confirmation → stock count → supplier setup → forecast and events → replenishment advice → draft order
// → approval → ordered → partial receipt → correction and supplier return → final receipt → updated stock,
// plus seller isolation, concurrency, sales rollback, an unavailable forecast service and insufficient data.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm } = require('./helpers');
const { todayIn } = require('../lib/imports');
const forecastService = require('../lib/forecastService');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); process.env.INVENTORY_CALENDAR_ENABLED = 'false'; process.env.FORECAST_UPPER_ESTIMATES_ENABLED = 'false'; });
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  forecastService.clearCache();
  process.env.FORECAST_V2_ENABLED = 'true';
  process.env.INVENTORY_CALENDAR_ENABLED = 'true';
  process.env.FORECAST_UPPER_ESTIMATES_ENABLED = 'true';
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const TZ = 'Asia/Karachi';
const day = (n) => new Date(Date.parse(`${todayIn(TZ)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const key = () => crypto.randomUUID();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const as = (s) => (method, path, json) => ctx.api(method, path, { token: s.token, json });
const one = async (sql, p = []) => (await ctx.pool.query(sql, p)).rows[0];

async function upload(s, products, days) {
  const lines = ['product_name,quantity,sale_date,revenue,category'];
  for (let n = -days; n <= -1; n += 1) for (const [name, q] of Object.entries(products)) lines.push(`${name},${q},${day(n)},${q * 10},Home`);
  const form = csvForm(lines.join('\n'));
  for (const [k, v] of Object.entries({ coverage_start: day(-days), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const r = await ctx.api('POST', '/data/upload', { token: s.token, form });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const pid = async (s, name) => (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, s.id])).id;

test('the full journey keeps stock, orders and advice consistent at every step', async () => {
  const A = as(a);
  // 1. Upload with a confirmed period; 2. stock count; 3. supplier and terms.
  await upload(a, { Kettle: 2 }, 40);
  const id = await pid(a, 'Kettle');
  assert.equal((await A('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: ago(120), items: [{ product_id: id, quantity: 20 }] })).status, 201);
  const sup = (await A('POST', '/suppliers', { name: 'Acme' })).body.id;
  assert.equal((await A('PUT', `/products/${id}/suppliers/${sup}`, { unit_cost: 100, currency: 'PKR', lead_time_days: 7, lead_time_max_days: 10, min_order_qty: 1, pack_size: 1 })).status, 200);
  // 4. Forecast (average tier: 40 days) and events.
  const fc = await A('GET', `/forecast/v2/${id}`);
  assert.deepEqual([fc.status, fc.body.history.tier, fc.body.forecasts.map(f => f.total_units)], [200, 'average', [14, 56]]);
  await A('PUT', '/calendar/settings', { country_code: 'PK' });
  await A('POST', '/calendar/entries', { kind: 'demand_scenario', title: 'Wedding season', start_date: day(8), end_date: day(14), demand_change_pct: 50 });
  const ue = await A('GET', `/forecast/v2/${id}/upper-estimates`);
  assert.deepEqual([ue.body.status, ue.body.reason.code], ['unavailable', 'market_pakistan'], 'upper estimates explain why they are not shown');
  // 5. Replenishment advice: the seller's +50% is applied and labelled.
  const rec = (await A('GET', `/inventory/items/${id}/replenishment`)).body;
  assert.deepEqual([rec.engine_version, rec.status, rec.actionable], ['replenishment-2', 'provisional', true]);
  assert.equal(rec.calendar.applied[0].label, 'assumed_by_seller');
  assert.equal(rec.suggestion.quantity, 17);
  // 6. Draft from the advice (concurrent duplicates → one draft); 7. approval (concurrent → one wins); 8. ordered.
  const body = { recommendation_id: rec.recommendation_id, inputs_sha256: rec.inputs_sha256 };
  const [d1, d2] = await Promise.all([A('POST', '/purchase-orders/from-recommendation', body), A('POST', '/purchase-orders/from-recommendation', body)]);
  assert.deepEqual([d1.status, d2.status].sort(), [200, 201]);
  const po = (d1.status === 201 ? d1 : d2).body.purchase_order;
  assert.equal(po.lines[0].quantity_ordered, 17);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_orders')).n, 1);
  const [ap1, ap2] = await Promise.all([A('POST', `/purchase-orders/${po.id}/approve`, { version: po.version }), A('POST', `/purchase-orders/${po.id}/approve`, { version: po.version })]);
  assert.deepEqual([ap1.status, ap2.status].sort(), [200, 409]);
  const approved = (ap1.status === 200 ? ap1 : ap2).body.purchase_order;
  const onHand = async () => (await A('GET', `/inventory/items/${id}`)).body.stock.on_hand;
  assert.equal(await onHand(), 20, 'approval never changes stock');
  const ordered = (await A('POST', `/purchase-orders/${po.id}/mark-ordered`, { version: approved.version, ordered_at: ago(100) })).body.purchase_order;
  // The order now counts as incoming: the earlier advice is stale and no second draft is offered.
  const stale = await A('POST', '/purchase-orders/from-recommendation', body);
  assert.equal(stale.status, 200, 'a replay returns the same draft, never a second one');
  const rec2 = (await A('GET', `/inventory/items/${id}/replenishment`)).body;
  assert.notEqual(rec2.inputs_sha256, rec.inputs_sha256);
  assert.equal(rec2.incoming.scheduled.length + (rec2.incoming.undated?.length || 0) + (rec2.incoming.overdue?.length || 0) >= 1, true);
  // 9. Partial receipt; 10. correction and supplier return; 11. final receipt.
  let r = await A('POST', `/purchase-orders/${po.id}/receipts`, { idempotency_key: key(), received_at: ago(60), lines: [{ line_id: ordered.lines[0].id, quantity: 10 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await onHand(), 30);
  let cur = (await A('GET', `/purchase-orders/${po.id}`)).body;
  assert.equal(cur.status, 'partially_received');
  const rl = cur.receipts[0].lines[0].receipt_line_id;
  r = await A('POST', `/purchase-orders/${po.id}/receipts/${cur.receipts[0].id}/corrections`, { idempotency_key: key(), version: cur.version, reason: 'one was missing', lines: [{ receipt_line_id: rl, quantity: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await onHand(), 29);
  cur = (await A('GET', `/purchase-orders/${po.id}`)).body;
  r = await A('POST', `/purchase-orders/${po.id}/receipts/${cur.receipts[0].id}/returns`, { idempotency_key: key(), version: cur.version, reason: 'damaged', returned_at: ago(30), lines: [{ receipt_line_id: rl, quantity: 2 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await onHand(), 27);
  cur = (await A('GET', `/purchase-orders/${po.id}`)).body;
  const remaining = cur.lines[0].quantity_remaining;
  assert.equal(remaining, 8, '17 ordered − (10 received − 1 corrected); a return does not reduce what was delivered');
  r = await A('POST', `/purchase-orders/${po.id}/receipts`, { idempotency_key: key(), received_at: ago(10), lines: [{ line_id: ordered.lines[0].id, quantity: remaining }] });
  assert.equal(r.status, 201);
  assert.equal((await A('GET', `/purchase-orders/${po.id}`)).body.status, 'received');
  // 12. Updated stock: 20 counted + 10 − 1 − 2 + 8; the advice now plans from it.
  assert.equal(await onHand(), 35);
  const rec3 = (await A('GET', `/inventory/items/${id}/replenishment`)).body;
  assert.equal(rec3.stock.on_hand, 35);
  // Supplier intelligence sees the delivered order.
  const perf = (await A('GET', `/suppliers/${sup}/performance`)).body.supplier;
  assert.deepEqual([perf.orders.placed, perf.orders.delivered, perf.quantities.returned_units], [1, 1, 2]);
  // A later count stays authoritative.
  await A('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date().toISOString(), items: [{ product_id: id, quantity: 33 }] });
  assert.equal(await onHand(), 33);
});

test('isolation: another seller cannot see or change any step', async () => {
  const A = as(a);
  const B = as(b);
  await upload(a, { Kettle: 2 }, 40);
  const id = await pid(a, 'Kettle');
  await A('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: ago(120), items: [{ product_id: id, quantity: 20 }] });
  const sup = (await A('POST', '/suppliers', { name: 'Acme' })).body.id;
  await A('PUT', `/products/${id}/suppliers/${sup}`, { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1 });
  const rec = (await A('GET', `/inventory/items/${id}/replenishment`)).body;
  const po = (await A('POST', '/purchase-orders/from-recommendation', { recommendation_id: rec.recommendation_id, inputs_sha256: rec.inputs_sha256 })).body.purchase_order;
  for (const [m, p, j] of [['GET', `/inventory/items/${id}`], ['GET', `/inventory/items/${id}/replenishment`], ['GET', `/forecast/v2/${id}`],
    ['GET', `/forecast/v2/${id}/upper-estimates`], ['GET', `/purchase-orders/${po.id}`], ['GET', `/suppliers/${sup}/performance`],
    ['POST', `/purchase-orders/${po.id}/approve`, { version: po.version }], ['PUT', `/products/${id}/suppliers/${sup}`, { unit_cost: 1, currency: 'PKR' }]]) {
    const r = await B(m, p, j);
    assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
  }
  const fb = await B('POST', '/purchase-orders/from-recommendation', { recommendation_id: rec.recommendation_id, inputs_sha256: rec.inputs_sha256 });
  assert.ok([404, 409].includes(fb.status));
  const before = (await A('GET', `/inventory/items/${id}/replenishment`)).body.inputs_sha256;
  await B('PUT', '/calendar/settings', { country_code: 'US' });
  await B('POST', '/calendar/entries', { kind: 'closure', title: 'Theirs', start_date: day(0), end_date: day(30) });
  await B('PUT', '/forecast/upper-estimates/settings', { status: 'confirmed', acknowledge: true });
  assert.equal((await A('GET', `/inventory/items/${id}/replenishment`)).body.inputs_sha256, before, 'another seller\'s calendar never reaches this product');
  assert.equal((await A('GET', '/forecast/upper-estimates/settings')).body.status, null);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE seller_id = $1', [b.id])).n, 0);
});

test('unavailable forecast service: stock, orders and receipts keep working; advice says unavailable, never guesses', async () => {
  const A = as(a);
  await upload(a, { Kettle: 2 }, 40);
  const id = await pid(a, 'Kettle');
  await A('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: ago(120), items: [{ product_id: id, quantity: 20 }] });
  ctx.ml.override = (info) => (info.url.startsWith('/v2/') ? { status: 503, body: { detail: 'down' } } : null);
  const rec = await A('GET', `/inventory/items/${id}/replenishment`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.status, 'unavailable');
  assert.equal(rec.body.suggestion, null);
  assert.equal((await A('GET', `/forecast/v2/${id}`)).status, 503);
  assert.equal((await A('GET', `/forecast/v2/${id}/upper-estimates`)).body.status, 'unavailable');
  assert.equal((await A('GET', `/inventory/items/${id}`)).body.stock.on_hand, 20, 'stock is still shown');
  const sup = (await A('POST', '/suppliers', { name: 'Acme' })).body.id;
  await A('PUT', `/products/${id}/suppliers/${sup}`, { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1 });
  const d = await A('POST', '/purchase-orders', { idempotency_key: key(), supplier_id: sup, lines: [{ product_id: id, quantity: 5 }] });
  assert.equal(d.status, 201, 'manual purchasing works without the ML service');
});

test('insufficient data: no forecast, no quantity, no draft; and a sales rollback never touches stock or orders', async () => {
  const A = as(a);
  const up = await upload(a, { Kettle: 2 }, 10);
  const id = await pid(a, 'Kettle');
  await A('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: ago(120), items: [{ product_id: id, quantity: 20 }] });
  const rec = (await A('GET', `/inventory/items/${id}/replenishment`)).body;
  assert.equal(rec.suggestion, null);
  assert.equal(rec.actionable, false);
  if (rec.recommendation_id) {
    const r = await A('POST', '/purchase-orders/from-recommendation', { recommendation_id: rec.recommendation_id, inputs_sha256: rec.inputs_sha256 });
    assert.equal(r.status, 409);
  }
  const sup = (await A('POST', '/suppliers', { name: 'Acme' })).body.id;
  await A('PUT', `/products/${id}/suppliers/${sup}`, { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1 });
  await A('POST', '/purchase-orders', { idempotency_key: key(), supplier_id: sup, lines: [{ product_id: id, quantity: 5 }] });
  const uploadId = up.upload_id ?? up.uploadId ?? up.upload?.id;
  const rb = await A('POST', `/data/rollback/${uploadId}`);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal((await A('GET', `/inventory/items/${id}`)).body.stock.on_hand, 20, 'the stock count survives a sales rollback');
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM purchase_order_lines WHERE product_id = $1', [id])).n, 1);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM sales s JOIN products p ON p.id = s.product_id WHERE p.id = $1', [id])).n, 0);
});
