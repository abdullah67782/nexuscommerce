// Cross-seller isolation: seller B must never see or use seller A's data,
// and products without an owner (user_id NULL) belong to nobody.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx, a, b, aProductId, orphanId;
before(async () => {
  ctx = await setup();
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 40)) });
  assert.equal(res.status, 200);
  aProductId = (await ctx.pool.query(`SELECT id FROM products WHERE user_id = $1`, [a.id])).rows[0].id;
  // Low stock so it appears in A's inventory alerts.
  await ctx.pool.query('UPDATE inventory SET stock_level = 2 WHERE product_id = $1', [aProductId]);
  // An ownerless product, as created by the old seeder.
  orphanId = (await ctx.pool.query(`INSERT INTO products (name) VALUES ('Orphan') RETURNING id`)).rows[0].id;
  await ctx.pool.query(`INSERT INTO sales (product_id, quantity, sale_date, revenue) VALUES ($1, 3, '2026-01-05', 30)`, [orphanId]);
});
after(async () => { await ctx.teardown(); });

test('product list only contains the seller’s own products', async () => {
  const mine = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(mine.body.products.map(p => p.id), [aProductId]);
  const theirs = await ctx.api('GET', '/products', { token: b.token });
  assert.deepEqual(theirs.body.products, []);
});

test('sales history only contains the seller’s own sales', async () => {
  const mine = await ctx.api('GET', '/sales', { token: a.token });
  assert.equal(mine.body.sales.length, 40);
  const theirs = await ctx.api('GET', '/sales', { token: b.token });
  assert.equal(theirs.body.sales.length, 0);
  const asking = await ctx.api('GET', `/sales?product=${aProductId}`, { token: b.token });
  assert.equal(asking.body.sales.length, 0, 'filtering by another seller’s product returns nothing');
  const ranged = await ctx.api('GET', '/sales?range=7', { token: a.token });
  assert.equal(ranged.body.sales.length, 8);
});

test('dashboard stats and data quality are per seller', async () => {
  const mine = await ctx.api('GET', '/dashboard/stats', { token: a.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.total_products, 1);
  assert.equal(mine.body.total_sales_records, 40);
  const theirs = await ctx.api('GET', '/dashboard/stats', { token: b.token });
  assert.equal(theirs.body.total_products, 0);
  assert.equal(theirs.body.total_sales_records, 0);
  assert.equal(theirs.body.total_revenue, 0);
  assert.equal(theirs.body.latest_quality_score, null);

  const q = await ctx.api('GET', '/data/quality', { token: a.token });
  assert.equal(q.status, 200);
  const qb = await ctx.api('GET', '/data/quality', { token: b.token });
  assert.equal(qb.status, 404, 'seller with no uploads has no quality report');
});

test('inventory alerts are per seller', async () => {
  const mine = await ctx.api('GET', '/inventory/alerts', { token: a.token });
  assert.equal(mine.body.length, 1);
  const theirs = await ctx.api('GET', '/inventory/alerts', { token: b.token });
  assert.deepEqual(theirs.body, []);
});

test('ownerless products are invisible to every seller', async () => {
  for (const s of [a, b]) {
    const products = await ctx.api('GET', '/products', { token: s.token });
    assert.ok(!products.body.products.some(p => p.id === orphanId));
    const f = await ctx.api('GET', `/forecast/${orphanId}?period=7`, { token: s.token });
    assert.equal(f.status, 404);
    const acc = await ctx.api('GET', `/forecast/${orphanId}/accuracy`, { token: s.token });
    assert.equal(acc.status, 404);
  }
});
