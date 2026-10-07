const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller } = require('./helpers');

let ctx, a;
before(async () => {
  ctx = await setup();
  a = await registerSeller(ctx.api, 'a@test.com');
});
after(async () => { await ctx.teardown(); });
beforeEach(() => ctx.ml.reset());

const payload = {
  products: [{ name: 'Mouse', category: 'Electronics', price: 10 }],
  sales: [
    { product_name: 'Mouse', quantity: 3, sale_date: '2026-01-01', revenue: 30 },
    { product_name: 'Mouse', quantity: 4, sale_date: '2026-01-02', revenue: 40 },
  ],
};

test('connecting a store imports sales and does not start fine-tuning', async () => {
  const res = await ctx.api('POST', '/store/connect', { token: a.token, json: payload });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'imported');
  assert.equal(res.body.records_imported, 2);
  assert.equal(res.body.fine_tuning.status, 'not_started');
  assert.equal(res.body.fine_tuning.automatic, false);
  assert.equal(ctx.ml.calls.length, 0, 'the ML server must not be contacted');

  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name), ['Mouse']);
});

test('reconnecting with the same data reports duplicates instead of failing', async () => {
  const res = await ctx.api('POST', '/store/connect', { token: a.token, json: payload });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, 0);
  assert.equal(res.body.duplicates_skipped, 2);
  assert.equal(res.body.products_created, 0);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM products WHERE user_id = $1', [a.id]);
  assert.equal(rows[0].n, 1);
});

test('invalid sale rows are counted as rejected, not imported', async () => {
  const res = await ctx.api('POST', '/store/connect', { token: a.token, json: {
    sales: [
      { product_name: 'Mouse', quantity: 'x', sale_date: '2026-01-03' },
      { product_name: 'Mouse', quantity: 2 },
      { product_name: 'Mouse', quantity: 2, sale_date: '2026-02-30' },
      { product_name: 'Mouse', quantity: 2, sale_date: '2999-01-01' },
    ],
  } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, 0);
  assert.equal(res.body.records_rejected, 4);
});

test('store connect requires login and an non-empty sales list', async () => {
  assert.equal((await ctx.api('POST', '/store/connect', { json: payload })).status, 401);
  assert.equal((await ctx.api('POST', '/store/connect', { token: a.token, json: { sales: [] } })).status, 400);
});
