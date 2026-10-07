// Sales whose import provenance contradicts the product's owner (written before
// seller isolation) must not reach seller-facing reads or forecasts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx, a, b, productA, conflictUpload;
before(async () => {
  ctx = await setup();
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
  // A's own history: 10 days ending 2026-01-10.
  const up = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 10, '2026-01-10')) });
  assert.equal(up.status, 200);
  productA = (await ctx.pool.query('SELECT id FROM products WHERE user_id = $1', [a.id])).rows[0].id;

  // Fixture reproducing the old bug: seller B's upload attached a sale to A's product.
  conflictUpload = (await ctx.pool.query(
    `INSERT INTO data_uploads (uploaded_by, file_format, total_records, clean_records, quality_score)
     VALUES ($1, 'csv', 1, 1, 100) RETURNING id`, [b.id])).rows[0].id;
  // Written before migration 002, which now forbids such rows; bypass its
  // trigger only to reproduce the legacy data.
  await ctx.pool.query('ALTER TABLE sales DISABLE TRIGGER sales_provenance_check');
  try {
    await ctx.pool.query(
      `INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id)
       VALUES ($1, 500, '2026-01-20', 5000, $2)`, [productA, conflictUpload]);
  } finally {
    await ctx.pool.query('ALTER TABLE sales ENABLE TRIGGER sales_provenance_check');
  }
});

test('new rows that contradict provenance are refused by the database', async () => {
  await assert.rejects(
    ctx.pool.query(`INSERT INTO sales (product_id, quantity, sale_date, upload_id) VALUES ($1, 1, '2026-01-21', $2)`,
      [productA, conflictUpload]),
    /sale provenance/);
  await assert.rejects(
    ctx.pool.query(`INSERT INTO products (name, user_id, upload_id) VALUES ('X', $1, $2)`, [a.id, conflictUpload]),
    /product provenance/);
});
after(async () => { await ctx.teardown(); });

test('the owner’s sales history excludes rows imported by another seller', async () => {
  const res = await ctx.api('GET', '/sales', { token: a.token });
  assert.equal(res.body.sales.length, 10);
  assert.ok(!res.body.sales.some(s => String(s.sale_date).startsWith('2026-01-20')));
  assert.ok(res.body.sales.every(s => s.quantity < 500));
  const filtered = await ctx.api('GET', `/sales?product=${productA}`, { token: a.token });
  assert.equal(filtered.body.sales.length, 10);
});

test('dashboard totals exclude the conflicting row', async () => {
  const res = await ctx.api('GET', '/dashboard/stats', { token: a.token });
  assert.equal(res.body.total_sales_records, 10);
  assert.ok(res.body.total_revenue < 5000);
  assert.ok(!String(res.body.date_range.end).startsWith('2026-01-20'));
});

test('forecast-vs-actual does not use the conflicting row as an actual', async () => {
  await ctx.pool.query(
    `INSERT INTO forecasts (product_id, seller_id, predicted_demand, forecast_date, model_used)
     VALUES ($1, $2, 7, '2026-01-20', 'xgboost')`, [productA, a.id]);
  const res = await ctx.api('GET', `/forecast/${productA}/accuracy`, { token: a.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.comparison, []);
});

test('freshness totals exclude the conflicting row', async () => {
  // Any new upload by A recalculates freshness.
  await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Pad'], 3, '2026-01-12')) });
  const res = await ctx.api('GET', '/data/freshness', { token: a.token });
  assert.equal(res.body.total_records, 13);
});

test('the shared attributed_sales view (also used by the ML server) excludes it', async () => {
  const { rows } = await ctx.pool.query(
    'SELECT COUNT(*)::int AS n, MAX(quantity) AS max_qty FROM attributed_sales WHERE product_id = $1 AND seller_id = $2',
    [productA, a.id]);
  assert.equal(rows[0].n, 10);
  assert.ok(rows[0].max_qty < 500);
  const total = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales WHERE product_id = $1', [productA]);
  assert.equal(total.rows[0].n, 11, 'the row is quarantined, not deleted');
});

test('the importing seller does not gain access either', async () => {
  const res = await ctx.api('GET', '/sales', { token: b.token });
  assert.equal(res.body.sales.length, 0);
  assert.equal((await ctx.api('GET', `/forecast/${productA}/accuracy`, { token: b.token })).status, 404);
});
