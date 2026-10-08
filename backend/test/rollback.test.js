const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => { await ctx.reset(); });

async function upload(token, csv) {
  const res = await ctx.api('POST', '/data/upload', { token, form: csvForm(csv) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test('only the most recent upload can be rolled back, and only once', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const v1 = await upload(a.token, salesCsv(['Mouse'], 10, '2026-01-10', false));
  const v2 = await upload(a.token, salesCsv(['Keyboard'], 10, '2026-01-20', false));

  const old = await ctx.api('POST', `/data/rollback/${v1.upload_id}`, { token: a.token });
  assert.equal(old.status, 400);

  const ok = await ctx.api('POST', `/data/rollback/${v2.upload_id}`, { token: a.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.rolled_back_rows, 10);

  const twice = await ctx.api('POST', `/data/rollback/${v2.upload_id}`, { token: a.token });
  assert.equal(twice.status, 400);

  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name), ['Mouse']);
  const versions = await ctx.api('GET', '/data/versions', { token: a.token });
  assert.equal(versions.body.versions.find(v => v.upload_id === v2.upload_id).is_rolled_back, true);
});

test('rolling back a sales file with stock columns: no inventory was written, unreferenced products removed', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const v1 = await upload(a.token, salesCsv(['Mouse'], 10, '2026-01-10', true));
  assert.ok(v1.stock_columns_ignored, 'stock columns reported as ignored');
  const stock = await ctx.pool.query('SELECT (SELECT COUNT(*) FROM inventory) + (SELECT COUNT(*) FROM stock_snapshots) AS n');
  assert.equal(Number(stock.rows[0].n), 0, 'sales files never write stock');
  const res = await ctx.api('POST', `/data/rollback/${v1.upload_id}`, { token: a.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM products');
  assert.equal(rows[0].n, 0);
});

test("a seller cannot roll back another seller's upload", async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const b = await registerSeller(ctx.api, 'b@test.com');
  const v1 = await upload(a.token, salesCsv(['Mouse'], 10, '2026-01-10', false));
  const res = await ctx.api('POST', `/data/rollback/${v1.upload_id}`, { token: b.token });
  assert.equal(res.status, 404);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales');
  assert.equal(rows[0].n, 10);
});
