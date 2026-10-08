// Stage 1a stock ledger through the real API (architect acceptance cases 1–6).
//   on_hand = selected verified count + Σ movements effective strictly after it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => { await ctx.reset(); });

const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const key = () => crypto.randomUUID();

async function seller(email, products = ['Mouse', 'Cable', 'Lamp']) {
  const s = await registerSeller(ctx.api, email);
  const up = await ctx.api('POST', '/data/upload', { token: s.token, form: csvForm(salesCsv(products, 10, '2026-01-31', false)) });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const { rows } = await ctx.pool.query('SELECT id, name FROM products WHERE user_id = $1', [s.id]);
  s.p = Object.fromEntries(rows.map(r => [r.name, r.id]));
  s.uploadId = up.body.upload_id;
  return s;
}
const count = (s, items, at, extra = {}) => ctx.api('POST', '/inventory/snapshots', {
  token: s.token, json: { idempotency_key: extra.key || key(), observed_at: at, items, ...extra.body },
});
const item = async (s, productId) => {
  const r = await ctx.api('GET', `/inventory/items/${productId}`, { token: s.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
async function feedSource(s, { since = ago(1000), physical = false } = {}) {
  const { rows } = await ctx.pool.query(
    `INSERT INTO data_sources (seller_id, kind, provider, external_id, display_name, timezone)
     VALUES ($1, 'api', 'shop', $2, 'Shop', 'UTC') RETURNING id`, [s.id, key()]);
  const put = await ctx.api('PUT', `/inventory/sources/${rows[0].id}`, {
    token: s.token, json: { reports_physical_on_hand: physical, shipment_feed_since: since } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return rows[0].id;
}
const ship = (s, sourceId, events) => ctx.api('POST', '/inventory/movements', { token: s.token, json: { source_id: sourceId, events } });
const stockRows = async () => (await ctx.pool.query(
  `SELECT (SELECT COUNT(*) FROM stock_snapshots)::int AS snaps, (SELECT COUNT(*) FROM stock_movements)::int AS moves,
          (SELECT COUNT(*) FROM inventory)::int AS legacy`)).rows[0];

test('1. missing stock, a measured zero and an unverified legacy value stay distinct', async () => {
  const a = await seller('a@test.com');
  assert.equal((await count(a, [{ product_id: a.p.Cable, quantity: 0 }], ago(2))).status, 201);
  // An unverified value as migration 004 creates it (no count time).
  const { rows: [loc] } = await ctx.pool.query('SELECT id FROM inventory_locations WHERE seller_id = $1', [a.id]);
  const { rows: [b] } = await ctx.pool.query(
    `INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id)
     VALUES ($1, 'legacy-migration-004', repeat('0', 64), 'legacy_migration', $2) RETURNING id`, [a.id, loc.id]);
  await ctx.pool.query(
    `INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, verification, legacy_recorded_at)
     VALUES ($1, $2, $3, $4, 5, 'unverified', '2026-01-01 10:00')`, [a.id, b.id, a.p.Lamp, loc.id]);
  assert.equal((await ctx.api('PATCH', '/inventory/policy', { token: a.token, json: { reorder_threshold: 3 } })).status, 200);

  const list = await ctx.api('GET', '/inventory/items', { token: a.token });
  assert.equal(list.status, 200);
  const by = Object.fromEntries(list.body.items.map(i => [i.name, i]));
  assert.deepEqual([by.Mouse.stock.known, by.Mouse.stock.on_hand, by.Mouse.readiness.stock.state, by.Mouse.threshold_alert],
    [false, null, 'missing', 'unknown_stock']);
  assert.deepEqual([by.Cable.stock.known, by.Cable.stock.on_hand, by.Cable.threshold_alert], [true, 0, 'below']);
  assert.deepEqual([by.Lamp.stock.known, by.Lamp.stock.on_hand, by.Lamp.readiness.stock.state, by.Lamp.stock.legacy.quantity,
    by.Lamp.threshold_alert], [false, null, 'unverified_only', 5, 'unknown_stock']);
  assert.equal(by.Lamp.readiness.overall, 'blocked');
  assert.equal(list.body.counts.unknown_stock, 2);
  assert.equal(list.body.counts.below_threshold, 1);
  assert.equal(by.Cable.stock.available_to_sell, 'not_tracked');
  assert.equal(by.Cable.readiness.commitments.state, 'not_tracked');

  // A verified count outranks the unverified value; the legacy value stays visible.
  await count(a, [{ product_id: a.p.Lamp, quantity: 4 }], ago(1));
  const lamp = await item(a, a.p.Lamp);
  assert.deepEqual([lamp.stock.on_hand, lamp.stock.legacy.quantity], [4, 5]);

  const alerts = await ctx.api('GET', '/inventory/alerts', { token: a.token });
  assert.deepEqual(alerts.body.map(x => [x.product_name, x.risk_level, x.stock_level]),
    [['Cable', 'critical', 0], ['Mouse', 'unknown', null]]);
});

test('2–3. count → shipment → newer count: no double deduction; revoking the newer count recomputes', async () => {
  const a = await seller('a@test.com');
  const src = await feedSource(a);
  await count(a, [{ product_id: a.p.Mouse, quantity: 20 }], ago(10));
  const sh = await ship(a, src, [{ external_event_id: 'o-1', kind: 'shipment', product_id: a.p.Mouse, quantity: 3, effective_at: ago(5) }]);
  assert.equal(sh.status, 201, JSON.stringify(sh.body));
  let m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.on_hand, m.stock.events_since_count, m.stock.movement_tracking, m.stock.position_type], [17, 1, 'declared_unverified', 'last_known']);

  const newer = await count(a, [{ product_id: a.p.Mouse, quantity: 16 }], ago(2)); // includes the shipment
  m = await item(a, a.p.Mouse);
  assert.equal(m.stock.on_hand, 16, 'the shipment is inside the newer count, not subtracted again');
  assert.deepEqual([m.stock.events_since_count, m.stock.events_included_in_count], [0, 1]);
  assert.equal(m.movements[0].relation, 'before_count_included', 'relation computed against the selected count');

  const rev = await ctx.api('POST', `/inventory/snapshots/${newer.body.batch_id}/revoke`, { token: a.token });
  assert.deepEqual([rev.status, rev.body.revoked], [200, 1]);
  m = await item(a, a.p.Mouse);
  assert.equal(m.stock.on_hand, 17, 'back to the older count minus the shipment');
  assert.equal(m.movements[0].relation, 'after_count');
  assert.equal(m.counts.find(c => c.batch_id === newer.body.batch_id).status, 'revoked', 'kept as evidence');
});

test('an event at exactly the count instant is inside the count and flagged for review', async () => {
  const a = await seller('a@test.com');
  const src = await feedSource(a);
  const t = ago(3);
  await count(a, [{ product_id: a.p.Mouse, quantity: 10 }], t);
  await ship(a, src, [{ external_event_id: 'o-same', kind: 'shipment', product_id: a.p.Mouse, quantity: 2, effective_at: t }]);
  const m = await item(a, a.p.Mouse);
  assert.equal(m.stock.on_hand, 10);
  assert.equal(m.movements[0].relation, 'at_count_included');
  assert.equal(m.readiness.reconciliation.state, 'needs_review');
});

test('4. a shipment replay changes nothing; a conflicting replay is refused and records nothing', async () => {
  const a = await seller('a@test.com');
  const src = await feedSource(a);
  await count(a, [{ product_id: a.p.Mouse, quantity: 20 }], ago(10));
  const ev = { external_event_id: 'o-1', kind: 'shipment', product_id: a.p.Mouse, quantity: 3, effective_at: ago(5), order_ref: 'A-1' };
  await ship(a, src, [ev]);
  const again = await ship(a, src, [ev]);
  assert.deepEqual([again.status, again.body.recorded, again.body.replayed], [200, 0, 1]);
  const before = await stockRows();
  const conflict = await ship(a, src, [
    { ...ev, external_event_id: 'o-2' },
    { ...ev, quantity: 4 },
  ]);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'event_conflict');
  assert.deepEqual(await stockRows(), before, 'o-2 was not recorded either');
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 17);
  // Same id twice inside one request with different content.
  const dup = await ship(a, src, [{ ...ev, external_event_id: 'o-3' }, { ...ev, external_event_id: 'o-3', quantity: 9 }]);
  assert.equal(dup.status, 409);
});

test('count identity: replay, already-recorded value, conflicting value, explicit supersession and its undo', async () => {
  const a = await seller('a@test.com');
  const t = ago(4);
  const k = key();
  const first = await count(a, [{ product_id: a.p.Mouse, quantity: 9 }], t, { key: k });
  assert.equal(first.status, 201);
  const replay = await count(a, [{ product_id: a.p.Mouse, quantity: 9 }], t, { key: k });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.batch_id], [200, true, first.body.batch_id]);
  const reused = await count(a, [{ product_id: a.p.Mouse, quantity: 8 }], t, { key: k });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, 'idempotency_conflict');

  const same = await count(a, [{ product_id: a.p.Mouse, quantity: 9 }], t);
  assert.deepEqual([same.status, same.body.recorded, same.body.already_recorded], [201, 0, 1]);
  assert.equal((await ctx.pool.query('SELECT COUNT(*)::int AS n FROM stock_snapshots')).rows[0].n, 1, 'no new observation');

  const conflicting = await count(a, [{ product_id: a.p.Mouse, quantity: 7 }, { product_id: a.p.Cable, quantity: 1 }], t);
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error, 'conflicting_count');
  assert.equal((await item(a, a.p.Cable)).stock.known, false, 'nothing of the submission was recorded');

  const sup = await count(a, [{ product_id: a.p.Mouse, quantity: 7 }], t, { body: { supersede: true } });
  assert.deepEqual([sup.status, sup.body.superseded], [201, 1]);
  let m = await item(a, a.p.Mouse);
  assert.equal(m.stock.on_hand, 7);
  assert.equal(m.counts.find(c => c.quantity === 9).status, 'superseded');

  await ctx.api('POST', `/inventory/snapshots/${sup.body.batch_id}/revoke`, { token: a.token });
  m = await item(a, a.p.Mouse);
  assert.equal(m.stock.on_hand, 9, 'undoing the supersession restores the earlier count');
});

test('5. historical sales uploads leave inventory unchanged and say why stock columns are ignored', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Mouse, quantity: 12 }], ago(3));
  const before = await stockRows();
  const res = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse', 'Desk'], 30, '2026-03-31', true)) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.stock_columns_ignored.columns, ['stock_level', 'reorder_threshold']);
  assert.match(res.body.stock_columns_ignored.message, /Inventory page/);
  assert.deepEqual(await stockRows(), before);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 12);
  const plain = await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Pen'], 5, '2026-04-10', false)) });
  assert.equal(plain.body.stock_columns_ignored, null);
});

test('6. another seller can neither read nor modify the records', async () => {
  const a = await seller('a@test.com');
  const b = await seller('b@test.com', ['Other']);
  const src = await feedSource(a, { physical: true });
  const c = await count(a, [{ product_id: a.p.Mouse, quantity: 5 }], ago(2));
  const before = await stockRows();

  assert.equal((await ctx.api('GET', `/inventory/items/${a.p.Mouse}`, { token: b.token })).status, 404);
  assert.equal((await ctx.api('GET', `/inventory/items/${a.p.Mouse}/policy`, { token: b.token })).status, 404);
  assert.equal((await ctx.api('PATCH', `/inventory/items/${a.p.Mouse}/policy`, { token: b.token, json: { reorder_threshold: 1 } })).status, 404);
  assert.equal((await ctx.api('POST', `/inventory/snapshots/${c.body.batch_id}/revoke`, { token: b.token })).status, 404);
  assert.equal((await ctx.api('GET', `/inventory/sources/${src}`, { token: b.token })).status, 404);
  assert.equal((await ctx.api('PUT', `/inventory/sources/${src}`, { token: b.token, json: { reports_physical_on_hand: true } })).status, 404);
  const foreignCount = await count(b, [{ product_id: a.p.Mouse, quantity: 1 }], ago(1));
  assert.deepEqual([foreignCount.status, foreignCount.body.errors[0].problem], [400, 'product_not_found']);
  const foreignByName = await count(b, [{ product_name: 'Mouse', quantity: 1 }], ago(1));
  assert.equal(foreignByName.status, 400, 'names resolve within the seller only');
  const foreignSource = await count(b, [{ product_id: b.p.Other, quantity: 1 }], ago(1), { body: { source_id: src } });
  assert.equal(foreignSource.status, 404);
  const foreignMove = await ctx.api('POST', '/inventory/movements', { token: b.token,
    json: { idempotency_key: key(), product_id: a.p.Mouse, kind: 'damage', quantity: 1, effective_at: ago(1), reason: 'x' } });
  assert.equal(foreignMove.status, 404);
  assert.equal((await ship(b, src, [{ external_event_id: 'x', kind: 'shipment', product_id: b.p.Other, quantity: 1, effective_at: ago(1) }])).status, 404);
  assert.deepEqual(await stockRows(), before);

  const list = await ctx.api('GET', '/inventory/items', { token: b.token });
  assert.deepEqual(list.body.items.map(i => i.name), ['Other']);
  assert.deepEqual((await ctx.api('GET', '/inventory/alerts', { token: b.token })).body.map(x => x.product_name), ['Other']);
  assert.equal((await ctx.api('GET', '/inventory/items', {})).status, 401);
});

test('movement tracking is reported separately from count age', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Mouse, quantity: 30 }], ago(20));
  let m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.movement_tracking, m.stock.position_type, m.readiness.stock.state, m.stock.last_count.age_days],
    [ 'absent', 'last_known', 'last_known', 0 ], 'a fresh count without a shipment feed is a last-known position');

  const src = await feedSource(a);
  m = await item(a, a.p.Mouse);
  // A declared feed is configured coverage, not verified delivery: never 'complete'.
  assert.deepEqual([m.stock.movement_tracking, m.stock.position_type, m.readiness.stock.state],
    ['declared_unverified', 'last_known', 'last_known']);
  assert.match(m.readiness.stock.reason, /not verified/);
  // Sales recorded on/after the count day by a source that sends no shipments.
  const today = new Date().toISOString().slice(0, 10);
  await ctx.api('POST', '/data/upload', { token: a.token, form: csvForm(salesCsv(['Mouse'], 1, today, false)) });
  m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.movement_tracking, m.stock.position_type, m.stock.untracked_sales_since_count >= 1], ['partial', 'last_known', true]);
  assert.ok(src);
});

// Regression (architect review 1a, P1): a later-starting feed cannot cover earlier sales.
const karachiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
async function storeSale(s, sourceId, productId, day) {
  const { rows: [u] } = await ctx.pool.query(
    `INSERT INTO data_uploads (uploaded_by, file_format, total_records, clean_records, source, source_id, idempotency_key)
     VALUES ($1, 'api', 1, 1, 'store_connect', $2, $3) RETURNING id`, [s.id, sourceId, key()]);
  await ctx.pool.query(
    `INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id, source_id, source_row_number)
     VALUES ($1, 1, $2, 10, $3, $4, 1)`, [productId, day, u.id, sourceId]);
}

test('feed coverage is evaluated per source interval; no feed declaration makes tracking complete', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Mouse, quantity: 30 }], ago(30));
  const feedA = await feedSource(a, { since: ago(1000) });          // starts before the count
  const feedB = await feedSource(a, { since: ago(1000) });
  await storeSale(a, feedB, a.p.Mouse, karachiToday());              // sold today through B
  let m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.movement_tracking, m.stock.untracked_sales_since_count], ['declared_unverified', 0],
    'B is declared to cover today: unverified, but no gap');

  // B's feed actually starts AFTER the count (and after the start of today): its
  // earlier sales are not covered, even though feed A covers the count.
  await ctx.api('PUT', `/inventory/sources/${feedB}`, { token: a.token,
    json: { reports_physical_on_hand: false, shipment_feed_since: ago(0.05) } });
  m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.movement_tracking, m.stock.untracked_sales_since_count, m.stock.position_type], ['partial', 1, 'last_known']);

  // Only feeds that start after the count: a gap right after the count.
  await ctx.api('PUT', `/inventory/sources/${feedA}`, { token: a.token,
    json: { reports_physical_on_hand: false, shipment_feed_since: ago(1) } });
  await ctx.pool.query('DELETE FROM sales WHERE source_id = $1', [feedB]);
  m = await item(a, a.p.Mouse);
  assert.equal(m.stock.movement_tracking, 'partial');

  const list = await ctx.api('GET', '/inventory/items', { token: a.token });
  assert.equal(list.body.counts.tracked, 0, 'no position is reported as tracked without verified synchronisation');
});

// Regression (architect review 1a, P2): same-instant movements with a NULL source.
test('same-instant movements: manual and other-source events need review; only the same connector is exempt', async () => {
  const a = await seller('a@test.com');
  const conn = await feedSource(a, { physical: true });
  const other = await feedSource(a);
  const t = ago(2);
  const c = await count(a, ['Mouse', 'Cable', 'Lamp'].map(n => ({ product_id: a.p[n], quantity: 10 })), t, { body: { source_id: conn } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const manual = await ctx.api('POST', '/inventory/movements', { token: a.token,
    json: { idempotency_key: key(), product_id: a.p.Mouse, kind: 'damage', quantity: 2, effective_at: t, reason: 'broken' } });
  assert.equal(manual.status, 201);
  await ship(a, conn, [{ external_event_id: 'same-src', kind: 'shipment', product_id: a.p.Cable, quantity: 2, effective_at: t }]);
  await ship(a, other, [{ external_event_id: 'other-src', kind: 'shipment', product_id: a.p.Lamp, quantity: 2, effective_at: t }]);

  const mouse = await item(a, a.p.Mouse);
  assert.deepEqual([mouse.stock.on_hand, mouse.readiness.reconciliation.state], [10, 'needs_review'],
    'manual event at the count instant: inside the count, but flagged');
  const cable = await item(a, a.p.Cable);
  assert.deepEqual([cable.stock.on_hand, cable.readiness.reconciliation.state], [10, 'none'],
    'the connector that reported the count establishes its own ordering');
  const lamp = await item(a, a.p.Lamp);
  assert.deepEqual([lamp.stock.on_hand, lamp.readiness.reconciliation.state], [10, 'needs_review']);
  const list = await ctx.api('GET', '/inventory/items', { token: a.token });
  assert.equal(list.body.counts.needs_review, 2);
});

test('rolling back across import kinds explains the shared version history', async () => {
  const a = await seller('a@test.com');
  const form = csvForm('product_name,quantity\nMouse,4', 'count.csv');
  form.append('counted_at', ago(1));
  const cf = await ctx.api('POST', '/inventory/count-files', { token: a.token, form });
  assert.equal(cf.status, 201);
  const rb = await ctx.api('POST', `/data/rollback/${a.uploadId}`, { token: a.token });
  assert.equal(rb.status, 400);
  assert.equal(rb.body.latest_version.kind, 'stock-count file');
  assert.match(rb.body.message, /share one version history/);
});

test('stale and inconsistent positions; per-product tolerance', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Mouse, quantity: 5 }], ago(24 * 10));
  let m = await item(a, a.p.Mouse);
  assert.equal(m.readiness.stock.state, 'stale');
  await ctx.api('PATCH', `/inventory/items/${a.p.Mouse}/policy`, { token: a.token, json: { stale_after_days: 30 } });
  m = await item(a, a.p.Mouse);
  assert.deepEqual([m.readiness.stock.state, m.policy.stale_after_days], ['last_known', 30]);

  const src = await feedSource(a);
  await count(a, [{ product_id: a.p.Cable, quantity: 1 }], ago(5));
  await ship(a, src, [{ external_event_id: 's1', kind: 'shipment', product_id: a.p.Cable, quantity: 3, effective_at: ago(1) }]);
  const c = await item(a, a.p.Cable);
  assert.deepEqual([c.stock.on_hand, c.readiness.stock.state, c.readiness.overall], [-2, 'inconsistent', 'blocked']);
});

test('manual adjustments: signs, reasons, kinds and identity', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Mouse, quantity: 10 }], ago(5));
  const adj = (body) => ctx.api('POST', '/inventory/movements', { token: a.token,
    json: { idempotency_key: key(), product_id: a.p.Mouse, effective_at: ago(1), ...body } });
  assert.equal((await adj({ kind: 'damage', quantity: 2, reason: 'dropped' })).status, 201);
  assert.equal((await adj({ kind: 'found', quantity: 1, reason: 'back shelf' })).status, 201);
  assert.equal((await adj({ kind: 'correction', quantity: -3, reason: 'miscount' })).status, 201);
  assert.equal((await adj({ kind: 'customer_return', quantity: 1 })).status, 201);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 10 - 2 + 1 - 3 + 1);
  assert.equal((await adj({ kind: 'damage', quantity: 2 })).status, 400, 'reason required');
  assert.equal((await adj({ kind: 'shipment', quantity: 2, reason: 'x' })).status, 400, 'shipments come from sources');
  assert.equal((await adj({ kind: 'receipt', quantity: 2, reason: 'x' })).status, 400, 'receipts come from purchase orders');
  assert.equal((await adj({ kind: 'damage', quantity: 1.5, reason: 'x' })).status, 400);
  assert.equal((await adj({ kind: 'damage', quantity: -2, reason: 'x' })).status, 400);
  assert.equal((await adj({ kind: 'correction', quantity: 0, reason: 'x' })).status, 400);
  assert.equal((await adj({ kind: 'damage', quantity: 1, reason: 'x', effective_at: '2026-10-01 10:00' })).status, 400, 'offset required');
  const k = key();
  const once = await ctx.api('POST', '/inventory/movements', { token: a.token,
    json: { idempotency_key: k, product_id: a.p.Mouse, kind: 'damage', quantity: 1, effective_at: ago(1), reason: 'x' } });
  const twice = await ctx.api('POST', '/inventory/movements', { token: a.token,
    json: { idempotency_key: k, product_id: a.p.Mouse, kind: 'damage', quantity: 1, effective_at: ago(1), reason: 'x' } });
  assert.deepEqual([once.status, twice.status, twice.body.error], [201, 409, 'event_conflict'], 'same key, different effective_at → refused');
});

test('count validation: offsets, future, negative, fractional, duplicates, physical-stock sources', async () => {
  const a = await seller('a@test.com');
  const bad = async (items, at, body) => (await count(a, items, at, { body })).status;
  assert.equal(await bad([{ product_id: a.p.Mouse, quantity: 1 }], '2026-10-01T10:00:00'), 400);
  assert.equal(await bad([{ product_id: a.p.Mouse, quantity: 1 }], new Date(Date.now() + 3600000).toISOString()), 400);
  assert.equal(await bad([{ product_id: a.p.Mouse, quantity: -1 }], ago(1)), 400);
  assert.equal(await bad([{ product_id: a.p.Mouse, quantity: 1.5 }], ago(1)), 400);
  assert.equal(await bad([{ product_id: a.p.Mouse, quantity: 1 }, { product_id: a.p.Mouse, quantity: 1 }], ago(1)), 400);
  assert.equal(await bad([], ago(1)), 400);
  const src = await feedSource(a, { physical: false });
  const notPhysical = await count(a, [{ product_id: a.p.Mouse, quantity: 1 }], ago(1), { body: { source_id: src } });
  assert.deepEqual([notPhysical.status, notPhysical.body.error], [422, 'source_not_physical_stock']);
  await ctx.api('PUT', `/inventory/sources/${src}`, { token: a.token, json: { reports_physical_on_hand: true, shipment_feed_since: ago(100) } });
  const ok = await count(a, [{ product_name: 'Mouse', quantity: 1 }], ago(1), { body: { source_id: src } });
  assert.equal(ok.status, 201);
  const { rows } = await ctx.pool.query("SELECT COUNT(*)::int AS n FROM stock_snapshots");
  assert.equal(rows[0].n, 1);
  // Shipments from an unmapped source are refused.
  const { rows: [other] } = await ctx.pool.query(
    `INSERT INTO data_sources (seller_id, kind, provider, external_id) VALUES ($1, 'api', 'shop', 'unmapped') RETURNING id`, [a.id]);
  const unmapped = await ship(a, other.id, [{ external_event_id: 'z', kind: 'shipment', product_id: a.p.Mouse, quantity: 1, effective_at: ago(1) }]);
  assert.deepEqual([unmapped.status, unmapped.body.error], [422, 'source_not_mapped']);
});

test('stock-count files: rejected rows reported, an import version, rollback revokes, sales untouched', async () => {
  const a = await seller('a@test.com');
  await count(a, [{ product_id: a.p.Lamp, quantity: 6 }], ago(30));
  const freshBefore = (await ctx.api('GET', '/data/freshness', { token: a.token })).body.last_upload_at;
  const csv = ['product_name,quantity', 'Mouse,14', 'Cable,3', 'Cable,3', 'Lamp,2', 'Lamp,4', 'Ghost,5', 'Cable,', 'Mouse,1.5', ',4'].join('\n');
  const form = csvForm(csv, 'count.csv');
  form.append('counted_at', ago(2));
  const res = await ctx.api('POST', '/inventory/count-files', { token: a.token, form });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.recorded, 2, 'Mouse and Cable');
  assert.equal(res.body.identical_duplicate_rows, 1);
  assert.equal(res.body.rejected, 6);
  assert.deepEqual(res.body.rejected_rows.map(r => r.problem).sort(),
    ['conflicting_duplicate', 'conflicting_duplicate', 'fractional_quantity', 'missing_value', 'missing_value', 'product_not_found']);
  assert.equal((await item(a, a.p.Lamp)).stock.on_hand, 6, 'conflicting rows leave the earlier count in place');
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 14);

  const versions = await ctx.api('GET', '/data/versions', { token: a.token });
  assert.equal(versions.body.versions[0].source, 'stock_count');
  const fresh = (await ctx.api('GET', '/data/freshness', { token: a.token })).body.last_upload_at;
  assert.equal(fresh, freshBefore, 'a count file does not make sales look fresh');
  const confirm = await ctx.api('POST', `/data/uploads/${res.body.upload_id}/coverage`, { token: a.token,
    json: { start: '2026-01-01', end: '2026-01-31', scope: 'all_products', confirmed: true } });
  assert.equal(confirm.status, 400);

  const rb = await ctx.api('POST', `/data/rollback/${res.body.upload_id}`, { token: a.token });
  assert.deepEqual([rb.status, rb.body.kind, rb.body.stock_counts_revoked, rb.body.rolled_back_rows], [200, 'stock_count', 2, 0]);
  assert.equal((await item(a, a.p.Mouse)).stock.known, false);
  assert.equal((await ctx.api('GET', '/sales', { token: a.token })).body.sales.length, 10, 'sales untouched');

  const empty = csvForm('product_name,quantity\nGhost,1', 'c.csv');
  empty.append('counted_at', ago(1));
  assert.equal((await ctx.api('POST', '/inventory/count-files', { token: a.token, form: empty })).status, 400);
  const noTime = csvForm('product_name,quantity\nMouse,1', 'c.csv');
  assert.equal((await ctx.api('POST', '/inventory/count-files', { token: a.token, form: noTime })).status, 400);
});

test('a sales rollback keeps products that have stock facts', async () => {
  const s = await registerSeller(ctx.api, 'a@test.com');
  const v = await ctx.api('POST', '/data/upload', { token: s.token, form: csvForm(salesCsv(['Counted', 'Moved', 'Set', 'Plain'], 5, '2026-01-10', true)) });
  const ids = Object.fromEntries((await ctx.pool.query('SELECT id, name FROM products WHERE user_id = $1', [s.id])).rows.map(r => [r.name, r.id]));
  await count(s, [{ product_id: ids.Counted, quantity: 3 }], ago(2));
  await ctx.api('POST', '/inventory/movements', { token: s.token,
    json: { idempotency_key: key(), product_id: ids.Moved, kind: 'found', quantity: 1, effective_at: ago(1), reason: 'shelf' } });
  await ctx.api('PATCH', `/inventory/items/${ids.Set}/policy`, { token: s.token, json: { reorder_threshold: 4 } });
  const rb = await ctx.api('POST', `/data/rollback/${v.body.upload_id}`, { token: s.token });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  const left = (await ctx.api('GET', '/products', { token: s.token })).body.products.map(p => p.name).sort();
  assert.deepEqual(left, ['Counted', 'Moved', 'Set']);
  assert.equal((await item(s, ids.Counted)).stock.on_hand, 3);
});
