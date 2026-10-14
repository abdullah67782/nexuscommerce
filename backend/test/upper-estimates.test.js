// Upper demand estimates (policy upper-estimates-policy-1): server-enforced applicability, fallback, seller
// isolation, and separation from the forecast and from replenishment. The ML numbers are tested in Python
// (ml/tests/test_upper_estimates.py); here the ML stub's values must pass through unchanged.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm } = require('./helpers');
const { todayIn } = require('../lib/imports');
const forecastService = require('../lib/forecastService');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => {
  await ctx.teardown();
  delete process.env.FORECAST_UPPER_ESTIMATES_ENABLED;
  delete process.env.INVENTORY_CALENDAR_ENABLED;
});
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  forecastService.clearCache();
  process.env.FORECAST_V2_ENABLED = 'true';
  process.env.FORECAST_UPPER_ESTIMATES_ENABLED = 'true';
  process.env.INVENTORY_CALENDAR_ENABLED = 'true';
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const TZ = 'Asia/Karachi';
const day = (n) => new Date(Date.parse(`${todayIn(TZ)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const one = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0];
const api = (method, path, token, json) => ctx.api(method, path, { token, json });

async function sales(seller, name, days) {
  const lines = ['product_name,quantity,sale_date,revenue,category'];
  for (let n = -days; n <= -1; n += 1) lines.push(`${name},3,${day(n)},30,Home`);
  const form = csvForm(lines.join('\n'));
  for (const [k, v] of Object.entries({ coverage_start: day(-days), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const res = await ctx.api('POST', '/data/upload', { token: seller.token, form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, seller.id])).id;
}
const est = (id, seller = a) => api('GET', `/forecast/v2/${id}/upper-estimates`, seller.token);
const country = (code, seller = a) => api('PUT', '/calendar/settings', seller.token, { country_code: code });
const upperCalls = () => ctx.ml.calls.filter(c => c.url === '/v2/upper-estimates');

async function eligible(seller = a, name = 'Mug', days = 200) {
  const id = await sales(seller, name, days);
  assert.equal((await country('US', seller)).status, 200);
  const s = await api('PUT', '/forecast/upper-estimates/settings', seller.token, { status: 'confirmed', acknowledge: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const t = await api('PUT', `/forecast/upper-estimates/products/${id}`, seller.token, { department: 'household' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return id;
}

test('policy order: switch, confirmed country, US market, store profile, product department — each with its reason', async () => {
  const id = await sales(a, 'Mug', 200);
  process.env.FORECAST_UPPER_ESTIMATES_ENABLED = 'false';
  let r = await est(id);
  assert.deepEqual([r.status, r.body.status, r.body.reason.code, r.body.estimates], [200, 'unavailable', 'disabled', []]);
  process.env.FORECAST_UPPER_ESTIMATES_ENABLED = 'true';
  r = await est(id);
  assert.equal(r.body.reason.code, 'country_not_confirmed');
  assert.equal((await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed', acknowledge: true })).body.error, 'country_not_confirmed');
  await country('PK');
  r = await est(id);
  assert.equal(r.body.reason.code, 'market_pakistan');
  assert.match(r.body.reason.text, /evaluated only on US Walmart benchmark data/);
  const pk = await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed', acknowledge: true });
  assert.deepEqual([pk.status, pk.body.error], [409, 'market_pakistan'], 'a Pakistan store cannot confirm the US profile');
  await country('US');
  r = await est(id);
  assert.equal(r.body.reason.code, 'profile_not_confirmed', 'the US alone does not establish applicability');
  assert.equal((await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed' })).body.error, 'acknowledgement_required');
  const s1 = await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed', acknowledge: true });
  assert.deepEqual([s1.status, s1.body.status, s1.body.version, s1.body.policy_version], [200, 'confirmed', 1, 'upper-estimates-policy-1']);
  r = await est(id);
  assert.equal(r.body.reason.code, 'product_type_not_set');
  assert.equal((await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'toys' })).status, 400);
  const t1 = await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'not_covered' });
  assert.equal(t1.body.version, 1);
  r = await est(id);
  assert.equal(r.body.reason.code, 'product_type_not_covered');
  assert.equal(upperCalls().length, 0, 'the ML service is not asked while a store or product condition fails');
  assert.equal((await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'foods' })).status, 428, 'version required');
  assert.equal((await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'foods', version: 9 })).status, 409);
  assert.equal((await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'foods', version: 1 })).body.version, 2);
  r = await est(id);
  assert.deepEqual([r.body.status, r.body.reason], ['available', null]);
  assert.ok(r.body.checks.every(c => c.ok));
  // Withdrawing the profile switches them off again.
  const w = await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'withdrawn', version: 1 });
  assert.deepEqual([w.status, w.body.version], [200, 2]);
  assert.equal((await est(id)).body.reason.code, 'profile_withdrawn');
  // Changing the store country afterwards also stops them.
  await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed', acknowledge: true, version: 2 });
  await country('PK');
  assert.equal((await est(id)).body.reason.code, 'market_pakistan');
  const events = (await ctx.pool.query('SELECT event FROM upper_estimate_events WHERE seller_id = $1 ORDER BY id', [a.id])).rows.map(x => x.event);
  assert.deepEqual(events, ['profile_confirmed', 'product_type_set', 'product_type_set', 'profile_withdrawn', 'profile_confirmed']);
  await assert.rejects(ctx.pool.query('DELETE FROM upper_estimate_events'), /append-only/);
});

test('available: ML values pass through unchanged, labelled one-sided, beside the same forecast and history as /v2', async () => {
  const id = await eligible();
  const fc = await api('GET', `/forecast/v2/${id}`, a.token);
  const r = await est(id);
  assert.equal(r.body.status, 'available');
  assert.equal(r.body.kind, 'one-sided upper demand estimate');
  assert.deepEqual(r.body.forecast.forecasts, fc.body.forecasts, 'the forecast beside the estimates is the forecast');
  const v2Call = ctx.ml.calls.find(c => c.url === '/v2/forecast');
  assert.deepEqual(upperCalls()[0].body, v2Call.body, 'the same confirmed history is sent');
  assert.equal(r.body.estimates.length, 4);
  for (const e of r.body.estimates) {
    const f = fc.body.forecasts.find(x => x.horizon_days === e.horizon_days);
    assert.equal(e.upper_units, f.total_units * (e.level === 0.8 ? 1.25 : 1.5) + 0.125, 'no rounding or change on the way');
    assert.deepEqual([e.start, e.end], [f.start, f.end]);
    assert.equal(e.lower_units, undefined, 'there is no lower estimate');
  }
  assert.ok(r.body.limitations.includes('Evaluated on US Walmart benchmark data; not calibrated to your store.'));
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM forecasts')).n, 0, 'nothing is stored');
});

test('data conditions come from the ML service: short history is unavailable with its reason, the forecast still shown', async () => {
  const id = await eligible(a, 'Jar', 60);
  const r = await est(id);
  assert.deepEqual([r.body.status, r.body.reason.code, r.body.estimates], ['unavailable', 'short_history', []]);
  assert.equal(r.body.forecast.history.tier, 'average');
  assert.equal((await api('GET', `/forecast/v2/${id}`, a.token)).body.forecasts.length, 2);
});

test('fallback: the upper-estimate service failing never affects the forecast', async () => {
  const id = await eligible();
  ctx.ml.override = (info) => (info.url === '/v2/upper-estimates' ? { status: 503, body: { detail: 'artifacts unavailable' } } : null);
  const r = await est(id);
  assert.deepEqual([r.status, r.body.status, r.body.reason.code], [200, 'unavailable', 'service_unavailable']);
  const fc = await api('GET', `/forecast/v2/${id}`, a.token);
  assert.deepEqual([fc.status, fc.body.status, fc.body.forecasts.length], [200, 'ok', 2]);
  assert.equal(fc.body.upper_estimates, undefined, 'the forecast response is unchanged');
});

test('seller isolation: products, answers and estimates are per seller', async () => {
  const id = await eligible();
  assert.equal((await est(id, b)).status, 404);
  assert.equal((await api('PUT', `/forecast/upper-estimates/products/${id}`, b.token, { department: 'foods' })).status, 404);
  const sb = await api('GET', '/forecast/upper-estimates/settings', b.token);
  assert.deepEqual([sb.body.status, sb.body.country.code], [null, null], 'A\'s answers are not B\'s');
  const sa = await api('GET', '/forecast/upper-estimates/settings', a.token);
  assert.deepEqual([sa.body.status, sa.body.country.code, sa.body.enabled], ['confirmed', 'US', true]);
  await assert.rejects(ctx.pool.query(
    `INSERT INTO upper_estimate_product_types (seller_id, product_id, department, updated_by) VALUES ($1, $2, 'foods', $1)`, [b.id, id]),
  /upper_estimate_product_types_product_fk/, 'a product type can only be recorded for the seller\'s own product');
  const own = await eligible(b, 'Bowl');
  assert.equal((await est(own, b)).body.status, 'available');
  assert.equal((await est(id)).body.status, 'available');
});

test('separate from replenishment: answers and estimates never change a recommendation or its fingerprint', async () => {
  const id = await sales(a, 'Mug', 200);
  const snap = await api('POST', '/inventory/snapshots', a.token, { idempotency_key: crypto.randomUUID(),
    observed_at: new Date(Date.now() - 60000).toISOString(), items: [{ product_id: id, quantity: 20 }] });
  assert.equal(snap.status, 201, JSON.stringify(snap.body));
  await country('US');
  const r0 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  await api('PUT', '/forecast/upper-estimates/settings', a.token, { status: 'confirmed', acknowledge: true });
  await api('PUT', `/forecast/upper-estimates/products/${id}`, a.token, { department: 'household' });
  assert.equal((await est(id)).body.status, 'available');
  const r1 = await api('GET', `/inventory/items/${id}/replenishment`, a.token);
  assert.equal(r1.body.inputs_sha256, r0.body.inputs_sha256);
  assert.deepEqual(r1.body.suggestion, r0.body.suggestion);
  assert.equal(JSON.stringify(r1.body).includes('upper_units'), false, 'no upper estimate reaches replenishment');
  const callsDuringReplenishment = ctx.ml.calls.filter(c => c.url === '/v2/upper-estimates').length;
  assert.equal(callsDuringReplenishment, 1, 'only the estimate request itself called the service');
});
