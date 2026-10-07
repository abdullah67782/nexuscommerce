// Every route must work with a single database connection: code that holds a
// checked-out client and then asks the pool for another one deadlocks there.
process.env.DB_POOL_MAX = '1';
process.env.DB_POOL_TIMEOUT_MS = '3000'; // a deadlock fails fast instead of hanging

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx, a;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  await ctx.reset();
  a = await registerSeller(ctx.api, 'a@test.com');
});

const noRevenue = { sales: [
  { product_name: 'Mouse', quantity: 3, sale_date: '2026-01-01' },
  { product_name: 'Mouse', quantity: 4, sale_date: '2026-01-02' },
] };
const connect = (json) => ctx.api('POST', '/store/connect', { token: a.token, json });

test('the pool really has one connection', () => {
  assert.equal(ctx.pool.options.max, 1);
});

test('an identical store-connect retry is replayed on a one-connection pool', async () => {
  const first = await connect(noRevenue);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await connect(noRevenue);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  const appended = await connect({ ...noRevenue, import_id: 'x', overlap_mode: 'append' });
  assert.equal(appended.status, 200, JSON.stringify(appended.body));
  const clash = await connect({ sales: [{ product_name: 'Mouse', quantity: 1, sale_date: '2026-01-03' }], import_id: 'x' });
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
});

test('concurrent retries while the pool is saturated all succeed', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => connect(noRevenue)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(results.filter(r => r.body.replayed === false).length, 1);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales');
  assert.equal(rows[0].n, 2);
});

test('upload, rollback and forecasting work on a one-connection pool', async () => {
  const up = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 10)) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const productId = (await ctx.pool.query('SELECT id FROM products WHERE user_id = $1', [a.id])).rows[0].id;
  const f = await ctx.api('GET', `/forecast/${productId}?period=7`, { token: a.token });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const rb = await ctx.api('POST', `/data/rollback/${up.body.upload_id}`, { token: a.token });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  const fresh = await ctx.api('GET', '/data/freshness', { token: a.token });
  assert.equal(fresh.body.total_records, 0);
});
