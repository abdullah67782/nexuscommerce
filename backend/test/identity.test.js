// Import identity (migration 002): batch identity that survives rollback,
// line ids with explicit conflicts, row identity that keeps genuine identical
// rows, overlap rules per source, business dates, per-seller serialisation and
// freshness after imports and rollbacks.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { setup, registerSeller, csvForm } = require('./helpers');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  await ctx.reset();
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const n = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0].n;
const salesCount = () => n('SELECT COUNT(*)::int AS n FROM sales');
const upload = (token, csv, fields = {}) => {
  const form = csvForm(csv);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return ctx.api('POST', '/data/upload', { token, form });
};
const connect = (token, json) => ctx.api('POST', '/store/connect', { token, json });
const CSV = ['product_name,quantity,sale_date,revenue',
  'Mouse,1,2026-01-01,10', 'Mouse,1,2026-01-01,10', 'Mouse,2,2026-01-02,20'].join('\n');

// ── Files ────────────────────────────────────────────────────────────────────
test('identical rows in a file are kept, with their original row numbers', async () => {
  const csv = ['product_name,quantity,sale_date,revenue',
    'Mouse,1,2026-01-01,10',
    'Mouse,1,2026-01-01,10',
    'Mouse,-1,2026-01-02,10',        // row 3: rejected
    'Pad,3,2026-01-02',              // no revenue
    'Pad,3,2026-01-02'].join('\n');
  const res = await upload(a.token, csv);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 4);
  assert.equal(res.body.identical_rows_kept, 2);
  assert.equal(res.body.rejected, 1);
  const rows = await ctx.pool.query('SELECT source_row_number FROM sales ORDER BY 1');
  assert.deepEqual(rows.rows.map(r => r.source_row_number), [1, 2, 4, 5]);
  const anomaly = await ctx.pool.query(`SELECT row_number FROM anomalies_detected WHERE anomaly_type = 'negative_value'`);
  assert.equal(anomaly.rows[0].row_number, 3);
});

test('operation ids: same id replays, reused id with other content conflicts, new id is a new operation', async () => {
  const first = await upload(a.token, CSV, { operation_id: 'op-1' });
  assert.equal(first.status, 200);
  const retry = await upload(a.token, CSV, { operation_id: 'op-1' });
  assert.equal(retry.body.replayed, true);
  const clash = await upload(a.token, `${CSV}\nPad,1,2026-01-03,5`, { operation_id: 'op-1' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'operation_id_conflict');

  const again = await upload(a.token, CSV, { operation_id: 'op-2' });
  assert.equal(again.status, 409, 'a new operation overlapping earlier rows must choose');
  assert.equal(again.body.error, 'overlap_requires_choice');
  assert.equal(await salesCount(), 3);
  const append = await upload(a.token, CSV, { operation_id: 'op-2', overlap_mode: 'append' });
  assert.equal(append.status, 200, JSON.stringify(append.body));
  assert.equal(append.body.version_number, 2);
  assert.equal(await salesCount(), 6);
});

test('a rolled-back file keeps its identity: a retry never restores it, a new operation can', async () => {
  const first = await upload(a.token, CSV);
  const rb = await ctx.api('POST', `/data/rollback/${first.body.upload_id}`, { token: a.token });
  assert.equal(rb.status, 200);
  const retry = await upload(a.token, CSV);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.rolled_back, true);
  assert.equal(await salesCount(), 0, 'the delayed retry did not bring the data back');
  const deliberate = await upload(a.token, CSV, { operation_id: 'reimport-1' });
  assert.equal(deliberate.status, 200, JSON.stringify(deliberate.body));
  assert.equal(deliberate.body.replayed, false);
  assert.equal(await salesCount(), 3);
  const status = await ctx.pool.query('SELECT status FROM data_uploads WHERE id = $1', [first.body.upload_id]);
  assert.equal(status.rows[0].status, 'rolled_back');
});

test('files with a line_id column use line identity across uploads', async () => {
  const f1 = ['line_id,product_name,quantity,sale_date', 'L1,Mouse,1,2026-01-01', 'L2,Mouse,1,2026-01-01'].join('\n');
  const f2 = ['line_id,product_name,quantity,sale_date', 'L2,Mouse,1,2026-01-01', 'L3,Mouse,4,2026-01-01'].join('\n');
  await upload(a.token, f1, { operation_id: 'f1' });
  const res = await upload(a.token, f2, { operation_id: 'f2' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.skipped, 1);
  assert.equal(await salesCount(), 3);
});

test('xlsx date cells (Excel serial numbers) become the right calendar day', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([['product_name', 'quantity', 'sale_date'], ['Mouse', 2, 45658]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sales');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'sales.xlsx');
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows } = await ctx.pool.query(`SELECT to_char(sale_date, 'YYYY-MM-DD') AS d FROM sales`);
  assert.deepEqual(rows.map(r => r.d), ['2025-01-01']);
});

test('ambiguous or invalid date formats are rejected, not guessed', async () => {
  const csv = ['product_name,quantity,sale_date', 'Mouse,1,01/02/2026', 'Mouse,1,2026-02-30', 'Mouse,1,2026-01-05'].join('\n');
  const res = await upload(a.token, csv);
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.rejected, 2);
});

// ── Store connect ───────────────────────────────────────────────────────────
const lines = (...l) => l.map(([id, qty, date = '2026-01-01']) =>
  ({ line_id: id, product_name: 'Mouse', quantity: qty, sale_date: date, revenue: qty * 10 }));

test('line ids: re-delivered lines are skipped, new lines imported', async () => {
  await connect(a.token, { import_id: 's1', sales: lines(['L1', 1], ['L2', 2]) });
  const res = await connect(a.token, { import_id: 's2', sales: lines(['L2', 2], ['L3', 3]) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.records_imported, 1);
  assert.equal(res.body.duplicates_skipped, 1);
  assert.equal(await salesCount(), 3);
});

test('a line id that arrives with changed contents is an explicit conflict and nothing is written', async () => {
  await connect(a.token, { import_id: 's1', sales: lines(['L1', 1]) });
  const res = await connect(a.token, { import_id: 's2', sales: lines(['L4', 4], ['L1', 9]) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'line_conflict');
  assert.equal(res.body.conflicts[0].line_id, 'L1');
  assert.equal(await salesCount(), 1, 'L4 was not written either');
  const within = await connect(a.token, { import_id: 's3', sales: lines(['L7', 1], ['L7', 2]) });
  assert.equal(within.status, 409, 'the same line id twice in one batch with different contents');
});

test('line ids are scoped to a connection; other connections and sellers are independent', async () => {
  await connect(a.token, { import_id: 's1', sales: lines(['L1', 1]) });
  const other = await connect(a.token, { import_id: 's2', connection: { provider: 'shopify', external_store_id: 'shop-2' },
    sales: lines(['L1', 1]) });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(other.body.records_imported, 1);
  const seller = await connect(b.token, { import_id: 's1', sales: lines(['L1', 1]) });
  assert.equal(seller.body.records_imported, 1);
  assert.equal(await salesCount(), 3);
});

test('overlap is only checked within the same source', async () => {
  await connect(a.token, { sales: [{ product_name: 'Mouse', quantity: 1, sale_date: '2026-01-01' }] });
  const viaFile = await upload(a.token, 'product_name,quantity,sale_date\nMouse,1,2026-01-01', { operation_id: 'f' });
  assert.equal(viaFile.status, 200, JSON.stringify(viaFile.body));
  assert.equal(await salesCount(), 2);
});

test('sale dates are business days in the connection timezone', async () => {
  const res = await connect(a.token, {
    connection: { provider: 'shopify', external_store_id: 'pk-1', timezone: 'Asia/Karachi' },
    sales: [
      { product_name: 'Mouse', quantity: 1, sale_date: '2026-01-01T22:30:00Z' },   // 03:30 next day in Karachi
      { product_name: 'Mouse', quantity: 1, sale_date: '2026-01-01 23:00' },       // already local
      { product_name: 'Mouse', quantity: 1, sale_date: '2026-01-01' },
    ] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows } = await ctx.pool.query(`SELECT to_char(sale_date, 'YYYY-MM-DD') AS d FROM sales ORDER BY source_row_number`);
  assert.deepEqual(rows.map(r => r.d), ['2026-01-02', '2026-01-01', '2026-01-01']);
  const tz = await ctx.pool.query(`SELECT timezone FROM data_sources WHERE external_id = 'pk-1'`);
  assert.equal(tz.rows[0].timezone, 'Asia/Karachi');
  const bad = await connect(a.token, { connection: { provider: 'x', external_store_id: 'y', timezone: 'Mars/Base' },
    sales: [{ product_name: 'Mouse', quantity: 1, sale_date: '2026-01-01' }] });
  assert.equal(bad.status, 400);
});

test('a rolled-back store import keeps its identity', async () => {
  const payload = { import_id: 'nightly-1', sales: lines(['L1', 1]) };
  const first = await connect(a.token, payload);
  await ctx.api('POST', `/data/rollback/${first.body.import_record_id}`, { token: a.token });
  const retry = await connect(a.token, payload);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.rolled_back, true);
  assert.equal(await salesCount(), 0);
  const fresh = await connect(a.token, { ...payload, import_id: 'nightly-1-reimport' });
  assert.equal(fresh.body.records_imported, 1);
});

// ── Per-seller serialisation and freshness ──────────────────────────────────
test('concurrent file uploads, store imports and a rollback keep versions unique and data consistent', async () => {
  const seed = await upload(a.token, 'product_name,quantity,sale_date\nSeed,1,2026-01-01');
  const ops = [
    ...[1, 2, 3].map(i => upload(a.token, `product_name,quantity,sale_date\nFile${i},${i},2026-01-0${i}`)),
    ...[1, 2].map(i => connect(a.token, { sales: [{ product_name: `Api${i}`, quantity: i, sale_date: '2026-01-05' }] })),
    ctx.api('POST', `/data/rollback/${seed.body.upload_id}`, { token: a.token }),
  ];
  const results = await Promise.all(ops);
  for (const r of results.slice(0, 5)) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok([200, 400].includes(results[5].status), 'rollback either ran first or found a newer import');
  const versions = await ctx.pool.query(
    'SELECT version_number FROM upload_versions WHERE seller_id = $1 ORDER BY version_number', [a.id]);
  assert.deepEqual(versions.rows.map(v => v.version_number), [1, 2, 3, 4, 5, 6]);
  const leftovers = await n(`SELECT COUNT(*)::int AS n FROM sales s JOIN data_uploads d ON d.id = s.upload_id
                             WHERE d.status = 'rolled_back'`);
  assert.equal(leftovers, 0);
});

test('freshness is recomputed after imports and rollbacks', async () => {
  const first = await upload(a.token, 'product_name,quantity,sale_date\nMouse,1,2026-01-01');
  const viaApi = await connect(a.token, { sales: [{ product_name: 'Pad', quantity: 2, sale_date: '2026-01-03' }] });
  let f = (await ctx.api('GET', '/data/freshness', { token: a.token })).body;
  assert.equal(f.total_records, 2);
  assert.equal(String(f.last_sale_date).slice(0, 10), '2026-01-03');

  await ctx.api('POST', `/data/rollback/${viaApi.body.import_record_id}`, { token: a.token });
  f = (await ctx.api('GET', '/data/freshness', { token: a.token })).body;
  assert.equal(f.total_records, 1);
  assert.equal(String(f.last_sale_date).slice(0, 10), '2026-01-01');
  const firstAt = (await ctx.pool.query('SELECT uploaded_at FROM data_uploads WHERE id = $1', [first.body.upload_id])).rows[0].uploaded_at;
  assert.equal(new Date(f.last_upload_at).getTime(), new Date(firstAt).getTime(), 'last upload is the remaining import');

  await ctx.api('POST', `/data/rollback/${first.body.upload_id}`, { token: a.token });
  f = (await ctx.api('GET', '/data/freshness', { token: a.token })).body;
  assert.equal(f.total_records, 0);
  assert.equal(f.last_upload_at, null);
  assert.equal(f.freshness_score, 0);
});
