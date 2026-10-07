const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => { await ctx.reset(); });

test('CSV upload stores sales, creates version 1 and reports quality', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse', 'Keyboard'], 30)) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 60);
  assert.equal(res.body.skipped, 0);
  assert.equal(res.body.version_number, 1);
  assert.ok(res.body.quality_score > 0);

  const versions = await ctx.api('GET', '/data/versions', { token: a.token });
  assert.equal(versions.body.versions.length, 1);
  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name).sort(), ['Keyboard', 'Mouse']);
  const freshness = await ctx.api('GET', '/data/freshness', { token: a.token });
  assert.equal(freshness.body.total_records, 60);
});

test('re-sending the same file without an operation id replays the original import', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const csv = salesCsv(['Mouse'], 20);
  const first = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
  const again = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.upload_id, first.body.upload_id);
  assert.equal(again.body.inserted, 20, 'replay reports the original result');
  const versions = await ctx.api('GET', '/data/versions', { token: a.token });
  assert.equal(versions.body.versions.length, 1);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales');
  assert.equal(rows[0].n, 20);
});

test('invalid rows are rejected and recorded as anomalies the seller can resolve', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const b = await registerSeller(ctx.api, 'b@test.com');
  const csv = [
    'product_name,quantity,sale_date,revenue',
    'Mouse,5,2026-01-01,50',
    'Mouse,-3,2026-01-02,30',
    ',4,2026-01-03,40',
  ].join('\n');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.rejected, 2);

  const anomalies = await ctx.api('GET', '/data/anomalies', { token: a.token });
  assert.equal(anomalies.body.anomalies.length, 2);
  const id = anomalies.body.anomalies[0].id;
  const notYours = await ctx.api('PATCH', `/data/anomalies/${id}/resolve`, { token: b.token });
  assert.equal(notYours.status, 404, 'another seller must not resolve this anomaly');
  const resolved = await ctx.api('PATCH', `/data/anomalies/${id}/resolve`, { token: a.token });
  assert.equal(resolved.status, 200);
  const bView = await ctx.api('GET', '/data/anomalies', { token: b.token });
  assert.equal(bView.body.anomalies.length, 0);
});

test('unsupported file types are refused and store nothing', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const form = new FormData();
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form });
  assert.notEqual(res.status, 200);
  const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales');
  assert.equal(rows[0].n, 0);
});

test('two sellers uploading the same product name get separate products', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const b = await registerSeller(ctx.api, 'b@test.com');
  await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 10)) });
  const res = await ctx.api('POST', '/data/upload', { token: b.token, form: csvForm(salesCsv(['Mouse'], 10, '2026-02-28')) });
  assert.equal(res.body.inserted, 10);

  const { rows } = await ctx.pool.query(
    `SELECT p.user_id, COUNT(s.id)::int AS n FROM products p JOIN sales s ON s.product_id = p.id
     WHERE p.name = 'Mouse' GROUP BY p.user_id ORDER BY p.user_id`);
  assert.deepEqual(rows, [{ user_id: a.id, n: 10 }, { user_id: b.id, n: 10 }]);
});

test('product names that collide with JavaScript object properties upload normally', async () => {
  const a = await registerSeller(ctx.api, 'a@test.com');
  const csv = ['product_name,quantity,sale_date,revenue',
    'constructor,1,2026-01-01,10', '__proto__,2,2026-01-01,20', 'toString,3,2026-01-01,30'].join('\n');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 3);
  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name).sort(), ['__proto__', 'constructor', 'toString']);
});

test('re-uploading the same file without a revenue column does not duplicate sales', async () => {
    const a = await registerSeller(ctx.api, 'a@test.com');
    const csv = ['product_name,quantity,sale_date', 'Mouse,1,2026-01-01', 'Mouse,2,2026-01-02'].join('\n');
    await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
    await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(csv) });
    const { rows } = await ctx.pool.query('SELECT COUNT(*)::int AS n FROM sales');
    assert.equal(rows[0].n, 2);
  });
