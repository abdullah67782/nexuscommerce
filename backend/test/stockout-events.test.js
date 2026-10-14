// Forecast context (Stage 3 §5 and §7.5): stock-out evidence is flagged, never imputed; events in the forecast
// period are listed with "effect unknown" (holidays) or the seller's own labels. The forecast itself is unchanged.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm } = require('./helpers');
const { todayIn } = require('../lib/imports');
const forecastService = require('../lib/forecastService');
const SF = require('../lib/stockoutFlags');

let ctx, a;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); delete process.env.INVENTORY_CALENDAR_ENABLED; });
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  forecastService.clearCache();
  process.env.FORECAST_V2_ENABLED = 'true';
  process.env.INVENTORY_CALENDAR_ENABLED = 'true';
  a = await registerSeller(ctx.api, 'a@test.com');
});

const TZ = 'Asia/Karachi';
const day = (n) => new Date(Date.parse(`${todayIn(TZ)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const noon = (d) => new Date(Date.parse(`${d}T07:00:00Z`)).toISOString();
const key = () => crypto.randomUUID();
const api = (method, path, json) => ctx.api(method, path, { token: a.token, json });
const one = async (sql, p = []) => (await ctx.pool.query(sql, p)).rows[0];

// 90 confirmed days. `zero(n)` → true for days with no sales.
async function upload(products) {
  const lines = ['product_name,quantity,sale_date,revenue'];
  for (let n = -90; n <= -1; n += 1) for (const [name, zero] of Object.entries(products)) if (!zero(n)) lines.push(`${name},2,${day(n)},20`);
  const form = csvForm(lines.join('\n'));
  for (const [k, v] of Object.entries({ coverage_start: day(-90), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  assert.equal((await ctx.api('POST', '/data/upload', { token: a.token, form })).status, 200);
  const ids = {};
  for (const name of Object.keys(products)) ids[name] = (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, a.id])).id;
  return ids;
}
const count = (id, q, d) => api('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: noon(d), items: [{ product_id: id, quantity: q }] });
async function receive(id, d) {
  const s = await api('POST', '/suppliers', { name: `S${id}-${key().slice(0, 4)}` });
  await api('PUT', `/products/${id}/suppliers/${s.body.id}`, { unit_cost: 1, currency: 'PKR', lead_time_days: 5, min_order_qty: 1, pack_size: 1 });
  const dr = await api('POST', '/purchase-orders', { idempotency_key: key(), supplier_id: s.body.id, lines: [{ product_id: id, quantity: 10 }] });
  let r = await api('POST', `/purchase-orders/${dr.body.purchase_order.id}/approve`, { version: 1 });
  r = await api('POST', `/purchase-orders/${dr.body.purchase_order.id}/mark-ordered`, { version: r.body.purchase_order.version, ordered_at: noon(day(-30)) });
  const x = await api('POST', `/purchase-orders/${dr.body.purchase_order.id}/receipts`, { idempotency_key: key(), received_at: noon(d),
    lines: [{ line_id: r.body.purchase_order.lines[0].id, quantity: 10 }] });
  assert.equal(x.status, 201, JSON.stringify(x.body));
}

test('recorded stock-out (count 0 → receipt, no sales between) is flagged, not imputed; the forecast input is unchanged', async () => {
  const { Lamp } = await upload({ Lamp: (n) => n >= -20 && n <= -15 });
  const plain = await api('GET', `/forecast/v2/${Lamp}`);
  const sentBefore = ctx.ml.calls.filter(c => c.url === '/v2/forecast').pop().body;
  assert.equal((await count(Lamp, 0, day(-20))).status, 201);
  await receive(Lamp, day(-14));
  const r = await api('GET', `/forecast/v2/${Lamp}`);
  assert.deepEqual(r.body.stockout_flags.supported.map(p => [p.start, p.end, p.days]), [[day(-20), day(-15), 6]]);
  assert.deepEqual(r.body.stockout_flags.suspected, [], 'a recorded period is not also "suspected"');
  assert.ok(r.body.notes.some(n => n.type === 'stockout' && /not adjusted/.test(n.text)));
  assert.deepEqual(ctx.ml.calls.filter(c => c.url === '/v2/forecast').pop().body, sentBefore, 'the same history is sent: nothing imputed');
  assert.deepEqual(r.body.forecasts, plain.body.forecasts);
});

test('suspected stock-outs: zero runs of ≥3 days for a daily seller, never inside your closures; and a current zero count', async () => {
  const { Mug, Bowl } = await upload({ Mug: (n) => n >= -10 && n <= -7, Bowl: (n) => n >= -10 && n <= -7 });
  let r = await api('GET', `/forecast/v2/${Mug}`);
  assert.deepEqual(r.body.stockout_flags.suspected.map(p => [p.start, p.end, p.days]), [[day(-10), day(-7), 4]]);
  assert.ok(r.body.notes.some(n => n.type === 'stockout_suspected' && /Not confirmed/.test(n.text)));
  // A declared closure over those days explains them.
  await api('PUT', '/calendar/settings', { country_code: 'PK' });
  await api('POST', '/calendar/entries', { kind: 'closure', title: 'Renovation', start_date: day(-10), end_date: day(-7) });
  r = await api('GET', `/forecast/v2/${Mug}`);
  assert.deepEqual(r.body.stockout_flags.suspected, []);
  // Latest count is 0 with no receipt since.
  await count(Bowl, 0, day(-2));
  r = await api('GET', `/forecast/v2/${Bowl}`);
  assert.equal(r.body.stockout_flags.current.since, day(-2));
  assert.ok(r.body.notes.some(n => n.type === 'stockout_current'));
});

test('pure rule: a positive count between the zero count and the receipt means no recorded stock-out', () => {
  const hist = { usable: { start: '2026-01-01', quantities: new Array(40).fill(0) } };
  const ev = (counts) => ({ tz: 'UTC', closures: [], receipts: [{ effective_at: '2026-01-20T10:00:00Z' }], counts });
  assert.equal(SF.flags(hist, ev([{ observed_at: '2026-01-10T10:00:00Z', quantity: 0 }])).supported.length, 1);
  assert.equal(SF.flags(hist, ev([{ observed_at: '2026-01-10T10:00:00Z', quantity: 0 }, { observed_at: '2026-01-15T10:00:00Z', quantity: 5 }])).supported.length, 0);
  const sold = { usable: { start: '2026-01-01', quantities: new Array(40).fill(0).map((_, i) => (i === 14 ? 1 : 0)) } };
  assert.equal(SF.flags(sold, ev([{ observed_at: '2026-01-10T10:00:00Z', quantity: 0 }])).supported.length, 0, 'a sale in between disproves it');
});

test('events in the forecast period: seller entries keep their labels; holidays say effect unknown; numbers unchanged', async () => {
  const { Lamp } = await upload({ Lamp: () => false });
  const plain = await api('GET', `/forecast/v2/${Lamp}`);
  await api('PUT', '/calendar/settings', { country_code: 'PK' });
  const start = plain.body.forecasts[0].start;
  const plus = (n) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  await api('POST', '/calendar/entries', { kind: 'demand_scenario', title: 'Sale week', start_date: plus(3), end_date: plus(6), demand_change_pct: 40 });
  await api('POST', '/calendar/entries', { kind: 'closure', title: 'Stocktake', start_date: plus(10), end_date: plus(10) });
  await api('POST', '/calendar/entries', { kind: 'closure', title: 'Far away', start_date: plus(60), end_date: plus(61) });
  const r = await api('GET', `/forecast/v2/${Lamp}`);
  const entries = r.body.events_in_horizon.filter(e => e.kind !== 'holiday');
  assert.deepEqual(entries.map(e => [e.name, e.label]), [['Sale week', 'assumed_by_seller'], ['Stocktake', 'declared_closure']]);
  assert.ok(r.body.events_in_horizon.filter(e => e.kind === 'holiday').every(h => h.effect_label === 'Effect unknown' && h.label === 'none'));
  assert.ok(r.body.notes.some(n => n.type === 'events' && /does not include any event effect/.test(n.text)));
  assert.deepEqual(r.body.forecasts, plain.body.forecasts, 'the forecast is unchanged');
});
