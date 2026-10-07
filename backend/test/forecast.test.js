const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx, a, b, aProductId;
before(async () => {
  ctx = await setup();
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
  await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 40)) });
  aProductId = (await ctx.pool.query('SELECT id FROM products WHERE user_id = $1', [a.id])).rows[0].id;
});
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  ctx.ml.reset();
  await ctx.pool.query('DELETE FROM forecasts');
});

const mlCalls = (url) => ctx.ml.calls.filter(c => c.url === url);

test('owner gets a forecast; the request reaches the ML server with their seller id', async () => {
  const res = await ctx.api('GET', `/forecast/${aProductId}?period=7`, { token: a.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.product_id, aProductId);
  assert.equal(res.body.forecast.points.length, 7);
  assert.deepEqual(Object.keys(res.body.forecast.points[0]).sort(), ['date', 'day', 'demand', 'lower', 'upper']);
  assert.ok(res.body.forecast.summary.total > 0);
  assert.equal(res.body.model_used, 'xgboost_fallback');
  const calls = mlCalls('/predict/xgboost');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.seller_id, a.id);
  assert.equal(calls[0].body.product_id, aProductId);
  assert.equal(calls[0].body.category, 'Electronics');
  const { rows } = await ctx.pool.query('SELECT DISTINCT seller_id FROM forecasts');
  assert.deepEqual(rows, [{ seller_id: a.id }]);
});

test("another seller gets 404 for someone else's product and the ML server is never called", async () => {
  const res = await ctx.api('GET', `/forecast/${aProductId}?period=7`, { token: b.token });
  assert.equal(res.status, 404);
  assert.equal(mlCalls('/predict/xgboost').length, 0);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM forecasts');
  assert.equal(rows[0].n, 0);
});

test('unknown and malformed product ids are rejected', async () => {
  assert.equal((await ctx.api('GET', '/forecast/999999', { token: a.token })).status, 404);
  assert.equal((await ctx.api('GET', '/forecast/abc', { token: a.token })).status, 400);
});

test('insufficient history from the ML server is passed through as 422', async () => {
  ctx.ml.override = (c) => c.url === '/predict/xgboost'
    ? { status: 422, body: { error: 'insufficient_history', days_available: 12, days_needed: 30 } } : null;
  const res = await ctx.api('GET', `/forecast/${aProductId}?period=7`, { token: a.token });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'insufficient_history');
  assert.equal(res.body.days_available, 12);
});

test('forecast-vs-actual only uses the seller’s own forecast rows', async () => {
  const insert = (sellerId, date, demand) => ctx.pool.query(
    `INSERT INTO forecasts (product_id, seller_id, predicted_demand, forecast_date, model_used)
     VALUES ($1, $2, $3, $4, 'xgboost')`, [aProductId, sellerId, demand, date]);
  await insert(a.id, '2026-01-20', 6);
  await insert(null, '2026-01-21', 999);   // legacy row without an owner
  await insert(b.id, '2026-01-22', 999);   // row attributed to another seller

  const mine = await ctx.api('GET', `/forecast/${aProductId}/accuracy`, { token: a.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.comparison.map(r => r.date), ['2026-01-20']);
  assert.equal(mine.body.comparison[0].predicted, 6);

  const theirs = await ctx.api('GET', `/forecast/${aProductId}/accuracy`, { token: b.token });
  assert.equal(theirs.status, 404);
});

test('model metrics are per seller', async () => {
  await ctx.pool.query(
    `INSERT INTO model_metrics (seller_id, model_name, mae, rmse, r2_score, mape, accuracy)
     VALUES ($1, 'xgboost_finetuned', 1, 1, 0.5, 0, 77)`, [a.id]);
  const mine = await ctx.api('GET', '/forecast/metrics', { token: a.token });
  assert.equal(mine.body.accuracy, 77);
  const theirs = await ctx.api('GET', '/forecast/metrics', { token: b.token });
  assert.equal(theirs.body.accuracy, null);
});

test('fine-tune status is requested for the logged-in seller only', async () => {
  const res = await ctx.api('GET', '/finetune/status', { token: b.token });
  assert.equal(res.status, 200);
  assert.deepEqual(mlCalls(`/finetune/status/${b.id}`).length, 1);
  assert.equal(ctx.ml.calls.length, 1);
});
