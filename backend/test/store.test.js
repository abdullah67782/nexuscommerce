const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller } = require('./helpers');

let ctx, a;
before(async () => {
  ctx = await setup();
});
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  ctx.ml.reset();
  await ctx.reset();
  a = await registerSeller(ctx.api, 'a@test.com');
});

const connect = (json, token = a.token) => ctx.api('POST', '/store/connect', { token, json });
const count = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0].n;
const salesCount = () => count('SELECT COUNT(*)::int AS n FROM sales');

const payload = {
  products: [{ name: 'Mouse', category: 'Electronics', price: 10 }],
  sales: [
    { product_name: 'Mouse', quantity: 3, sale_date: '2026-01-01', revenue: 30 },
    { product_name: 'Mouse', quantity: 4, sale_date: '2026-01-02', revenue: 40 },
  ],
};
// Same shape, but the source system sends no revenue.
const noRevenue = {
  sales: [
    { product_name: 'Mouse', quantity: 3, sale_date: '2026-01-01' },
    { product_name: 'Mouse', quantity: 4, sale_date: '2026-01-02' },
  ],
};

test('connecting a store imports sales and does not start fine-tuning', async () => {
  const res = await connect(payload);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'imported');
  assert.equal(res.body.records_imported, 2);
  assert.equal(res.body.replayed, false);
  assert.equal(res.body.fine_tuning.status, 'not_started');
  assert.equal(res.body.fine_tuning.automatic, false);
  assert.equal(ctx.ml.calls.length, 0, 'the ML server must not be contacted');
  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name), ['Mouse']);
});

test('each import gets one import record, a version and provenance on every row', async () => {
  const res = await connect(payload);
  const imports = await ctx.pool.query(
    `SELECT id, source, uploaded_by FROM data_uploads WHERE uploaded_by = $1`, [a.id]);
  assert.equal(imports.rows.length, 1);
  assert.equal(imports.rows[0].source, 'store_connect');
  assert.equal(res.body.import_record_id, imports.rows[0].id);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM sales WHERE upload_id = $1', [imports.rows[0].id]), 2);
  const versions = await ctx.api('GET', '/data/versions', { token: a.token });
  assert.equal(versions.body.versions.length, 1);
  assert.equal(versions.body.versions[0].upload_id, imports.rows[0].id);

  // The batch can be rolled back like a file upload.
  const rb = await ctx.api('POST', `/data/rollback/${imports.rows[0].id}`, { token: a.token });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal(await salesCount(), 0);
});

test('retrying the same payload without revenue does not duplicate sales', async () => {
  const first = await connect(noRevenue);
  assert.equal(first.body.records_imported, 2);
  const retry = await connect(noRevenue);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.import_record_id, first.body.import_record_id);
  assert.equal(retry.body.records_imported, 2, 'replay reports the original result');
  assert.equal(await salesCount(), 2);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM data_uploads'), 1);
});

test('an explicit import_id is idempotent, and reusing it for different data is refused', async () => {
  const first = await connect({ ...noRevenue, import_id: 'shop-sync-2026-01-02' });
  assert.equal(first.status, 200);
  const retry = await connect({ ...noRevenue, import_id: 'shop-sync-2026-01-02' });
  assert.equal(retry.body.replayed, true);
  const clash = await connect({ sales: [{ product_name: 'Mouse', quantity: 9, sale_date: '2026-01-03' }],
    import_id: 'shop-sync-2026-01-02' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'import_id_conflict');
  assert.equal(await salesCount(), 2);
});

test('a new import_id with rows already imported is refused unless the import says append', async () => {
  await connect({ ...noRevenue, import_id: 'batch-1' });
  const second = await connect({ ...noRevenue, import_id: 'batch-2' });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, 'overlap_requires_choice');
  assert.deepEqual(second.body.overlaps.map(o => o.sale_date), ['2026-01-01', '2026-01-02']);
  assert.equal(await salesCount(), 2, 'nothing written');
  const append = await connect({ ...noRevenue, import_id: 'batch-2', overlap_mode: 'append' });
  assert.equal(append.status, 200, JSON.stringify(append.body));
  assert.equal(append.body.records_imported, 2);
  assert.equal(await salesCount(), 4);
});

test('concurrent identical retries create exactly one import', async () => {
  const results = await Promise.all([connect(noRevenue), connect(noRevenue), connect(noRevenue)]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(results.filter(r => r.body.replayed === false).length, 1);
  assert.equal(new Set(results.map(r => r.body.import_record_id)).size, 1);
  assert.equal(await salesCount(), 2);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM data_uploads'), 1);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM upload_versions'), 1);
});

test('product names that collide with JavaScript object properties import normally', async () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  const res = await connect({
    products: names.map(name => ({ name })),
    sales: names.map((name, i) => ({ product_name: name, quantity: i + 1, sale_date: '2026-01-05', revenue: 10 })),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, names.length);
  assert.equal(res.body.products_created, names.length);
  const products = await ctx.api('GET', '/products', { token: a.token });
  assert.deepEqual(products.body.products.map(p => p.name).sort(), [...names].sort());
});

test('invalid sale rows are counted as rejected, not imported', async () => {
  const res = await connect({
    sales: [
      { product_name: 'Mouse', quantity: 'x', sale_date: '2026-01-03' },
      { product_name: 'Mouse', quantity: 2 },
      { product_name: 'Mouse', quantity: 2, sale_date: '2026-02-30' },
      { product_name: 'Mouse', quantity: 2, sale_date: '2999-01-01' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, 0);
  assert.equal(res.body.records_rejected, 4);
});

test('store connect requires login, a non-empty sales list and a sane import_id', async () => {
  assert.equal((await ctx.api('POST', '/store/connect', { json: payload })).status, 401);
  assert.equal((await connect({ sales: [] })).status, 400);
  assert.equal((await connect({ ...payload, import_id: 'x'.repeat(201) })).status, 400);
  assert.equal((await connect({ ...payload, import_id: 42 })).status, 400);
});

test('two genuine identical orders in one import are both kept (with and without revenue)', async () => {
  const res = await connect({ sales: [
    { product_name: 'Mouse', quantity: 1, sale_date: '2026-01-07', revenue: 10 },
    { product_name: 'Mouse', quantity: 1, sale_date: '2026-01-07', revenue: 10 },
    { product_name: 'Pad', quantity: 2, sale_date: '2026-01-07' },
    { product_name: 'Pad', quantity: 2, sale_date: '2026-01-07' },
  ] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, 4);
  assert.equal(res.body.identical_rows_kept, 2);
  assert.equal(await salesCount(), 4);
  const rows = await ctx.pool.query('SELECT source_row_number FROM sales ORDER BY source_row_number');
  assert.deepEqual(rows.rows.map(r => r.source_row_number), [1, 2, 3, 4]);
});
