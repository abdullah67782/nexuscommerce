// Forecasting milestone, backend side:
//  - cleaning decisions: no invented values, missing / fractional quantities
//    rejected, large orders kept and flagged, ambiguous dates explained;
//  - Asia/Karachi default for new sources, per-source timezone;
//  - confirmed coverage (migration 003): zero-transaction imports, period checks,
//    revocation on rollback;
//  - history resolution (unknown gaps preserved, zeros only inside coverage) and
//    the switchable v2 endpoint.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, csvForm } = require('./helpers');
const { productHistory } = require('../lib/coverage');

let ctx, a, b;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => {
  await ctx.reset();
  ctx.ml.reset();
  delete process.env.FORECAST_V2_ENABLED;
  a = await registerSeller(ctx.api, 'a@test.com');
  b = await registerSeller(ctx.api, 'b@test.com');
});

const one = async (sql, params = []) => (await ctx.pool.query(sql, params)).rows[0];
const upload = (token, csv, fields = {}) => {
  const form = csvForm(csv);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return ctx.api('POST', '/data/upload', { token, form });
};
const covered = (start, end, scope = 'all_products') =>
  ({ coverage_start: start, coverage_end: end, coverage_scope: scope, coverage_confirmed: 'true' });
const HEADER = 'product_name,quantity,sale_date,revenue';
const day = (start, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
const productId = async (name, seller = a) => (await one('SELECT id FROM products WHERE name = $1 AND user_id = $2', [name, seller.id])).id;

// ── Cleaning ─────────────────────────────────────────────────────────────────
test('missing, non-numeric and fractional quantities are rejected; nothing is imputed', async () => {
  await upload(a.token, 'product_name,price,quantity,sale_date\nMouse,25,1,2026-01-01');
  const res = await upload(a.token, ['product_name,price,quantity,sale_date,revenue',
    'Mouse,,2,2026-01-02,',          // missing price and revenue: kept, nothing invented
    'Mouse,30,,2026-01-03,10',       // missing quantity
    'Mouse,30,two,2026-01-04,10',    // not a number
    'Mouse,30,1.5,2026-01-05,10',    // fractional
    'Mouse,30,0,2026-01-06,10'].join('\n'), { operation_id: 'x' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.inserted, 1);
  assert.equal(res.body.rejected, 4);
  assert.equal(res.body.quality_score, 20);
  assert.equal(res.body.values_imputed, undefined);
  const kinds = (await ctx.pool.query(`SELECT anomaly_type, row_number FROM anomalies_detected ORDER BY row_number`)).rows;
  assert.deepEqual(kinds.map(k => k.anomaly_type), ['missing_quantity', 'invalid_quantity', 'fractional_quantity', 'zero_quantity']);
  const sale = await one(`SELECT quantity, revenue FROM sales WHERE sale_date = '2026-01-02'`);
  assert.equal(sale.revenue, null, 'missing revenue stays empty');
  assert.equal(Number((await one('SELECT current_price FROM products')).current_price), 25, 'missing price leaves it unchanged');
});

test('unusually large orders are kept and flagged, never removed', async () => {
  const lines = [HEADER];
  for (let i = 0; i < 20; i++) lines.push(`Mouse,${2 + (i % 3)},${day('2026-01-01', i)},10`);
  lines.push('Mouse,400,2026-01-21,4000');
  const res = await upload(a.token, lines.join('\n'));
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 21);
  assert.equal(res.body.large_orders_flagged, 1);
  assert.equal(Number((await one('SELECT SUM(quantity) AS n FROM sales')).n), 400 + 59);
  const flag = await one(`SELECT row_number, severity FROM anomalies_detected WHERE anomaly_type = 'unusually_large_order'`);
  assert.deepEqual(flag, { row_number: 21, severity: 'warning' });
});

test('ambiguous dates are rejected with the accepted formats', async () => {
  const res = await upload(a.token, `${HEADER}\nMouse,1,03/04/2026,10\nMouse,1,2026-04-03,10`);
  assert.equal(res.status, 200);
  assert.equal(res.body.rejected, 1);
  assert.match(res.body.date_help.message, /ambiguous.*YYYY-MM-DD, for example 2026-04-03/);
  assert.ok(res.body.date_help.accepted_formats.some(f => f.startsWith('YYYY-MM-DD')));
  assert.deepEqual(res.body.date_help.examples, [{ row: 1, value: '03/04/2026' }]);
});

// ── Timezones ────────────────────────────────────────────────────────────────
test('new sources default to Asia/Karachi; a source timezone can be changed for future imports', async () => {
  // 2026-01-31T20:30Z is 1 February in Karachi.
  const res = await upload(a.token, `${HEADER}\nMouse,1,2026-01-31T20:30:00Z,10`);
  assert.equal(res.body.source_timezone, 'Asia/Karachi');
  assert.equal((await one('SELECT to_char(sale_date, \'YYYY-MM-DD\') AS d FROM sales')).d, '2026-02-01');

  const list = await ctx.api('GET', '/data/sources', { token: a.token });
  assert.equal(list.body.default_timezone, 'Asia/Karachi');
  const id = list.body.sources[0].id;
  const bad = await ctx.api('PATCH', `/data/sources/${id}`, { token: a.token, json: { timezone: 'Mars/Base' } });
  assert.equal(bad.status, 400);
  const other = await ctx.api('PATCH', `/data/sources/${id}`, { token: b.token, json: { timezone: 'UTC' } });
  assert.equal(other.status, 404);
  const ok = await ctx.api('PATCH', `/data/sources/${id}`, { token: a.token, json: { timezone: 'UTC' } });
  assert.equal(ok.body.timezone, 'UTC');
  assert.equal((await one('SELECT to_char(sale_date, \'YYYY-MM-DD\') AS d FROM sales')).d, '2026-02-01', 'stored dates are not reinterpreted');
  await upload(a.token, `${HEADER}\nPad,1,2026-01-31T20:30:00Z,10`, { operation_id: 'utc' });
  assert.equal((await one(`SELECT to_char(sale_date, 'YYYY-MM-DD') AS d FROM sales s JOIN products p ON p.id = s.product_id WHERE p.name = 'Pad'`)).d, '2026-01-31');
});

// ── Coverage ─────────────────────────────────────────────────────────────────
test('a confirmed export with no sales is accepted only with coverage for all products', async () => {
  const empty = await upload(a.token, HEADER);
  assert.equal(empty.status, 400);
  const listed = await upload(a.token, HEADER, covered('2026-01-01', '2026-01-07', 'listed_products'));
  assert.equal(listed.status, 400);
  const unconfirmed = await upload(a.token, HEADER, { ...covered('2026-01-01', '2026-01-07'), coverage_confirmed: 'false' });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.body.message, /explicitly confirmed/);
  const future = await upload(a.token, HEADER, covered('2026-01-01', '2999-01-01'));
  assert.equal(future.status, 400);

  const ok = await upload(a.token, HEADER, covered('2026-01-01', '2026-01-07'));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.inserted, 0);
  assert.deepEqual({ ...ok.body.coverage, coverage_id: 0 }, { coverage_id: 0, start: '2026-01-01', end: '2026-01-07', scope: 'all_products', days: 7, products: 'all' });
  const replay = await upload(a.token, HEADER, covered('2026-01-01', '2026-01-07'));
  assert.equal(replay.body.replayed, true);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM data_coverage')).n, 1);
});

test('coverage rows must lie in the period and may not overlap earlier data of the same source', async () => {
  const outside = await upload(a.token, `${HEADER}\nMouse,1,2026-01-10,10`, covered('2026-01-01', '2026-01-07'));
  assert.equal(outside.status, 400);
  assert.equal(outside.body.error, 'rows_outside_coverage');
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM sales')).n, 0);

  await upload(a.token, `${HEADER}\nMouse,1,2026-01-03,10`);
  const overlap = await upload(a.token, `${HEADER}\nPad,1,2026-01-02,10`, covered('2026-01-01', '2026-01-07'));
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error, 'coverage_overlaps_existing_data');
  // listed scope for another product does not overlap Mouse's rows
  const pad = await upload(a.token, `${HEADER}\nPad,1,2026-01-02,10`, covered('2026-01-01', '2026-01-07', 'listed_products'));
  assert.equal(pad.status, 200, JSON.stringify(pad.body));
  assert.equal(pad.body.coverage.products, 1);
  // ... but a second declaration for Pad over the same days does
  const again = await upload(a.token, `${HEADER}\nPad,2,2026-01-05,10`, covered('2026-01-04', '2026-01-09', 'listed_products'));
  assert.equal(again.status, 409);
});

test('a file with rejected rows cannot be confirmed as complete', async () => {
  const res = await upload(a.token, `${HEADER}\nMouse,1,2026-01-02,10\nMouse,,2026-01-03,10\nMouse,1,03/01/2026,10`,
    covered('2026-01-01', '2026-01-07'));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'coverage_with_rejected_rows');
  assert.deepEqual(res.body.rejected_rows.map(r => r.problem), ['missing_quantity', 'invalid_date']);
  assert.ok(res.body.date_help.accepted_formats.length);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM sales')).n, 0);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM data_uploads')).n, 0, 'the claimed identity is released');
});

test('new rows inside a confirmed period need an explicit append', async () => {
  await upload(a.token, `${HEADER}\nMouse,1,2026-01-02,10`, covered('2026-01-01', '2026-01-07'));
  const late = await upload(a.token, `${HEADER}\nMouse,1,2026-01-05,10`, { operation_id: 'late' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'overlap_requires_choice');
  assert.equal(late.body.overlaps[0].inside_confirmed_coverage, true);
  const appended = await upload(a.token, `${HEADER}\nMouse,1,2026-01-05,10`, { operation_id: 'late', overlap_mode: 'append' });
  assert.equal(appended.status, 200);
  const outside = await upload(a.token, `${HEADER}\nMouse,1,2026-01-08,10`, { operation_id: 'after' });
  assert.equal(outside.status, 200, 'days after the confirmed period are not affected');
});

test('rolling back an import revokes its coverage', async () => {
  const res = await upload(a.token, `${HEADER}\nMouse,1,2026-01-02,10`, covered('2026-01-01', '2026-01-07'));
  const rb = await ctx.api('POST', `/data/rollback/${res.body.upload_id}`, { token: a.token });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.coverage_revoked, 1);
  const c = await one('SELECT status, revoke_reason, revoked_by FROM data_coverage');
  assert.deepEqual(c, { status: 'revoked', revoke_reason: 'rollback', revoked_by: a.id });
  // Zero-row imports can be rolled back too.
  const zero = await upload(a.token, HEADER, covered('2026-02-01', '2026-02-03'));
  const rb2 = await ctx.api('POST', `/data/rollback/${zero.body.upload_id}`, { token: a.token });
  assert.equal(rb2.body.coverage_revoked, 1);
});

test('store connect: confirmed coverage, including an empty delivery', async () => {
  const connect = (json) => ctx.api('POST', '/store/connect', { token: a.token, json });
  const conn = { provider: 'shopify', external_store_id: 's1' };
  assert.equal((await connect({ connection: conn, sales: [] })).status, 400);
  const bad = await connect({ connection: conn, sales: [], coverage: { start: '2026-01-01', end: '2026-01-03', scope: 'all_products' } });
  assert.equal(bad.status, 400, 'confirmation is required');
  const ok = await connect({ connection: conn, sales: [], coverage: { start: '2026-01-01', end: '2026-01-03', scope: 'all_products', confirmed: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.records_imported, 0);
  assert.equal(ok.body.coverage.days, 3);
  assert.equal((await one('SELECT evidence FROM data_coverage')).evidence, 'connector_full_export');
  const invalid = await connect({ connection: conn, sales: [{ product_name: 'Mouse', quantity: 1.5, sale_date: '2026-01-05' }],
    coverage: { start: '2026-01-04', end: '2026-01-06', scope: 'all_products', confirmed: true } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'coverage_with_rejected_rows');
});

// ── History resolution ───────────────────────────────────────────────────────
test('history: recorded days are used, unknown gaps are kept, zeros only inside confirmed periods', async () => {
  // Jan 1-10 recorded on alternate days (no coverage), then Jan 11-20 confirmed with sales on 3 days.
  const early = [HEADER];
  for (let i = 0; i < 10; i += 2) early.push(`Mouse,2,${day('2026-01-01', i)},10`);
  await upload(a.token, early.join('\n'));
  await upload(a.token, `${HEADER}\nMouse,5,2026-01-12,10\nMouse,1,2026-01-15,10\nMouse,4,2026-01-15,10`,
    covered('2026-01-11', '2026-01-20'));
  const h = await productHistory(ctx.pool, a.id, await productId('Mouse'));
  assert.equal(h.first_sale, '2026-01-01');
  assert.deepEqual(h.counts, { covered: 10, recorded: 5, unknown: 5 });
  // Jan 2, 4, 6, 8 and 10 have no rows and no confirmed period: unknown, not zero.
  assert.deepEqual(h.gaps.map(g => g.start), ['2026-01-02', '2026-01-04', '2026-01-06', '2026-01-08', '2026-01-10']);
  assert.equal(h.usable.start, '2026-01-11');
  assert.equal(h.usable.end, '2026-01-20');
  assert.deepEqual(h.usable.quantities, [0, 5, 0, 0, 5, 0, 0, 0, 0, 0]);
  assert.equal(h.usable.covered_days, 10);
  assert.equal(h.usable.recorded_days, 0);
});

test('history: a revoked period turns its empty days back into unknown', async () => {
  const res = await upload(a.token, `${HEADER}\nMouse,3,2026-01-01,10\nMouse,3,2026-01-05,10`, covered('2026-01-01', '2026-01-05'));
  let h = await productHistory(ctx.pool, a.id, await productId('Mouse'));
  assert.equal(h.usable.days, 5);
  await ctx.api('POST', `/data/rollback/${res.body.upload_id}`, { token: a.token });
  await upload(a.token, `${HEADER}\nMouse,3,2026-01-01,10\nMouse,3,2026-01-05,10`, { operation_id: 'plain' });
  h = await productHistory(ctx.pool, a.id, await productId('Mouse'));
  assert.equal(h.usable.days, 1);
  assert.deepEqual(h.gaps, [{ start: '2026-01-02', end: '2026-01-04', days: 3 }]);
});

// ── v2 endpoint ──────────────────────────────────────────────────────────────
test('v2 endpoint is off unless switched on, and only serves the owner', async () => {
  await upload(a.token, `${HEADER}\nMouse,1,2026-01-01,10`);
  const id = await productId('Mouse');
  const off = await ctx.api('GET', `/forecast/v2/${id}`, { token: a.token });
  assert.equal(off.status, 404);
  assert.equal(off.body.error, 'forecast_v2_disabled');
  assert.equal((await ctx.api('GET', '/forecast/v2/config', { token: a.token })).body.enabled, false);
  process.env.FORECAST_V2_ENABLED = 'true';
  assert.equal((await ctx.api('GET', `/forecast/v2/${id}`, { token: b.token })).status, 404);
  assert.equal((await ctx.api('GET', `/forecast/v2/${id}`, { token: a.token })).status, 200);
});

test('v2 endpoint sends only the usable history and explains gaps and tiers', async () => {
  process.env.FORECAST_V2_ENABLED = 'true';
  // 40 recorded days, a 5-day hole, then 30 days inside a confirmed period.
  const lines = [HEADER];
  for (let i = 0; i < 40; i++) lines.push(`Mouse,3,${day('2025-10-01', i)},10`);
  await upload(a.token, lines.join('\n'));
  const later = [HEADER];
  for (let i = 0; i < 30; i += 3) later.push(`Mouse,2,${day('2025-11-15', i)},10`);
  await upload(a.token, later.join('\n'), covered('2025-11-15', '2025-12-14'));

  const res = await ctx.api('GET', `/forecast/v2/${await productId('Mouse')}`, { token: a.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sent = ctx.ml.calls.find(c => c.url === '/v2/forecast').body;
  assert.equal(sent.start, '2025-11-15');
  assert.equal(sent.quantities.length, 30);
  assert.equal(sent.quantities.filter(q => q === 0).length, 20, 'zeros only inside the confirmed period');
  assert.equal(res.body.history.tier, 'average');
  assert.deepEqual(res.body.history.gaps, [{ start: '2025-11-10', end: '2025-11-14', days: 5 }]);
  const types = res.body.notes.map(n => n.type);
  assert.ok(types.includes('gap') && types.includes('tier') && types.includes('stale'), types.join());
  assert.match(res.body.notes.find(n => n.type === 'gap').text, /unknown, not zero/);
  assert.equal(res.body.forecasts.length, 2);
  assert.deepEqual(res.body.forecasts.map(f => [f.start, f.end]), [['2025-12-15', '2025-12-21'], ['2025-12-15', '2026-01-11']]);
  for (const f of res.body.forecasts) {
    assert.equal(Object.keys(f).some(k => /accuracy|confidence|lower|upper|daily/i.test(k)), false);
  }
});

test('v2 endpoint: insufficient history returns no forecast; the ML server being down is a clear 503', async () => {
  process.env.FORECAST_V2_ENABLED = 'true';
  await upload(a.token, `${HEADER}\nMouse,1,2026-01-01,10\nMouse,1,2026-01-02,10`);
  const id = await productId('Mouse');
  const res = await ctx.api('GET', `/forecast/v2/${id}`, { token: a.token });
  assert.equal(res.body.status, 'insufficient_history');
  assert.deepEqual(res.body.forecasts, []);
  ctx.ml.override = () => ({ status: 503, body: { detail: 'v2 manifest not found' } });
  const down = await ctx.api('GET', `/forecast/v2/${id}`, { token: a.token });
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'forecast_v2_unavailable');
});
