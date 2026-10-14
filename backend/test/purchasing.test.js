// Stage 1b: suppliers, purchase orders, receipts, corrections, returns, cancellation.
// Rules (plan §3.2, §10): approval never changes stock; receiving writes one movement
// per line; a later count stays authoritative; replays never add stock twice; a
// correction affects only the corrected quantity; a cancelled order never reopens.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => { await ctx.reset(); });

const key = () => crypto.randomUUID();
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const karachiDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' })
  .format(new Date(Date.now() + offsetDays * 86400000));

async function seller(email, products = ['Mouse', 'Cable', 'Lamp']) {
  const s = await registerSeller(ctx.api, email);
  const up = await ctx.api('POST', '/data/upload', { token: s.token, form: csvForm(salesCsv(products, 10, '2026-01-31', false)) });
  assert.equal(up.status, 200);
  const { rows } = await ctx.pool.query('SELECT id, name FROM products WHERE user_id = $1', [s.id]);
  s.p = Object.fromEntries(rows.map(r => [r.name, r.id]));
  return s;
}
const call = (s, method, path, json) => ctx.api(method, path, { token: s.token, json });
async function supplier(s, name = 'Karachi Textiles', extra = {}) {
  const r = await call(s, 'POST', '/suppliers', { name, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
async function terms(s, productId, supplierId, t = {}) {
  const r = await call(s, 'PUT', `/products/${productId}/suppliers/${supplierId}`,
    { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 10, pack_size: 5, ...t });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function draft(s, supplierId, lines, extra = {}) {
  const r = await call(s, 'POST', '/purchase-orders', { idempotency_key: key(), supplier_id: supplierId, lines, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.purchase_order;
}
const po = async (s, id) => (await call(s, 'GET', `/purchase-orders/${id}`)).body;
const act = (s, id, action, body = {}) => call(s, 'POST', `/purchase-orders/${id}/${action}`, body);
async function approveAndOrder(s, order) {
  let r = await act(s, order.id, 'approve', { version: order.version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await act(s, order.id, 'mark-ordered', { version: r.body.purchase_order.version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.purchase_order;
}
const receive = (s, order, lines, at = ago(1), k = key()) => act(s, order.id, 'receipts',
  { idempotency_key: k, received_at: at, lines: lines.map(([i, q]) => ({ line_id: order.lines[i].id, quantity: q })) });
const item = async (s, productId) => (await call(s, 'GET', `/inventory/items/${productId}`)).body;
const count = (s, productId, quantity, at) => call(s, 'POST', '/inventory/snapshots',
  { idempotency_key: key(), observed_at: at, items: [{ product_id: productId, quantity }] });
const movements = async () => (await ctx.pool.query('SELECT COUNT(*)::int AS n FROM stock_movements')).rows[0].n;

test('suppliers and terms: validation, currency never assumed, one preferred supplier', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  assert.equal((await call(a, 'POST', '/suppliers', { name: ' karachi textiles ' })).status, 409, 'names are unique per seller');
  assert.equal((await call(a, 'POST', '/suppliers', { name: 'X', default_currency: 'rupees' })).status, 400);
  const noCurrency = await call(a, 'PUT', `/products/${a.p.Mouse}/suppliers/${s1}`, { unit_cost: 50 });
  assert.equal(noCurrency.status, 400, 'a cost without its currency is refused');
  assert.match(noCurrency.body.message, /never assumed/);
  assert.equal((await call(a, 'PUT', `/products/${a.p.Mouse}/suppliers/${s1}`, { pack_size: 0 })).status, 400);
  const t = await terms(a, a.p.Mouse, s1, { is_preferred: true });
  assert.deepEqual([t.unit_cost, t.currency, t.pack_size, t.min_order_qty], [100, 'PKR', 5, 10]);
  const s2 = await supplier(a, 'Lahore Imports', { default_currency: 'USD' });
  await terms(a, a.p.Mouse, s2, { is_preferred: true, currency: 'USD', unit_cost: 1.25 });
  const links = (await call(a, 'GET', `/products/${a.p.Mouse}/suppliers`)).body.links;
  assert.deepEqual(links.filter(l => l.is_preferred).map(l => l.supplier_id), [s2], 'one preferred supplier per product');
  // Changing a supplier's default currency never rewrites entered costs.
  await call(a, 'PATCH', `/suppliers/${s2}`, { default_currency: 'EUR' });
  const after = (await call(a, 'GET', `/products/${a.p.Mouse}/suppliers`)).body.links.find(l => l.supplier_id === s2);
  assert.equal(after.currency, 'USD');
  // Missing settings are visible in readiness.
  await call(a, 'PUT', `/products/${a.p.Cable}/suppliers/${s1}`, { pack_size: 1 });
  assert.equal((await item(a, a.p.Cable)).readiness.supplier.state, 'missing_lead_time');
  assert.equal((await item(a, a.p.Lamp)).readiness.supplier.state, 'none');
});

test('draft → approve → ordered → partial receipt → received; approval never changes stock', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1);
  await terms(a, a.p.Cable, s1, { unit_cost: 40, pack_size: 1, min_order_qty: 1 });
  await count(a, a.p.Mouse, 10, ago(48));
  let order = await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 12 }, { product_id: a.p.Cable, quantity: 3 }],
    { expected_arrival: karachiDay(5) });
  assert.equal(order.status, 'draft');
  assert.equal(order.currency, 'PKR', 'the supplier default currency (editable)');
  assert.deepEqual(order.lines[0].problems.map(p => p.problem), ['not_a_pack_multiple']);

  // D5: refused at approval with a clear message, never rounded.
  const refused = await act(a, order.id, 'approve', { version: order.version });
  assert.equal(refused.status, 422);
  assert.match(refused.body.problems[0].detail, /Packs of 5: order 10 or 15/);
  assert.equal((await po(a, order.id)).status, 'draft');
  const fixed = await call(a, 'PATCH', `/purchase-orders/${order.id}`,
    { version: order.version, lines: [{ product_id: a.p.Mouse, quantity: 15 }, { product_id: a.p.Cable, quantity: 3 }] });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  order = fixed.body.purchase_order;
  assert.equal(order.totals.cost, 15 * 100 + 3 * 40);

  const before = { moves: await movements(), onHand: (await item(a, a.p.Mouse)).stock.on_hand };
  let r = await act(a, order.id, 'approve', { version: order.version });
  assert.equal(r.status, 200);
  assert.equal((await item(a, a.p.Mouse)).inbound.approved_not_sent, 15);
  r = await act(a, order.id, 'mark-ordered', { version: r.body.purchase_order.version });
  order = r.body.purchase_order;
  assert.equal(order.status, 'ordered');
  let m = await item(a, a.p.Mouse);
  assert.deepEqual([await movements(), m.stock.on_hand], [before.moves, before.onHand], 'approval and ordering change no stock');
  assert.deepEqual([m.inbound.open_quantity, m.inbound.next_expected, m.readiness.inbound.state], [15, karachiDay(5), 'open']);

  r = await receive(a, order, [[0, 6]]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.stock_effects.map(e => [e.kind, e.quantity]), [['receipt', 6]]);
  order = r.body.purchase_order;
  assert.equal(order.status, 'partially_received');
  m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.on_hand, m.inbound.open_quantity], [16, 9], 'received goods move from incoming to on-hand');

  r = await receive(a, order, [[0, 9], [1, 3]]);
  order = r.body.purchase_order;
  assert.equal(order.status, 'received');
  assert.ok(order.completed_at);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 25);
  assert.deepEqual(order.events.map(e => e.event),
    ['created', 'edited', 'approved', 'ordered', 'received_goods', 'status_changed', 'received_goods', 'status_changed']);
});

test('receipt identity: replay and concurrent duplicates add stock once; conflicts and over-receipt record nothing', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  await count(a, a.p.Mouse, 0, ago(48));
  const order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 10 }]));
  const k = key();
  const at = ago(2);
  const [x, y] = await Promise.all([receive(a, order, [[0, 4]], at, k), receive(a, order, [[0, 4]], at, k)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  const again = await receive(a, order, [[0, 4]], at, k);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.stock_effects[0].movement_id, x.body.stock_effects[0].movement_id);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 4, 'one receipt, one movement');
  const n = await movements();
  assert.equal((await receive(a, order, [[0, 5]], at, k)).status, 409, 'same id, different goods');
  const over = await receive(a, order, [[0, 7]]);
  assert.deepEqual([over.status, over.body.error], [409, 'over_receipt'], 'D4: only 6 remain');
  assert.equal(await movements(), n);
  assert.equal((await po(a, order.id)).totals.received, 4);
});

test('a later physical count stays authoritative over receipts and corrections; returns apply when they happen', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  await count(a, a.p.Mouse, 10, ago(10));
  let order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 20 }]));
  const rec = await receive(a, order, [[0, 20]], ago(8));
  order = rec.body.purchase_order;
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 30);
  await count(a, a.p.Mouse, 28, ago(6));                 // the count already includes the receipt
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 28, 'the receipt is inside the later count, not added again');

  const receipt = order.receipts[0];
  const corr = await act(a, order.id, `receipts/${receipt.id}/corrections`,
    { idempotency_key: key(), reason: 'Packing slip said 20; only 15 arrived', lines: [{ receipt_line_id: receipt.lines[0].receipt_line_id, quantity: 5 }] });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  assert.deepEqual(corr.body.stock_effects.map(e => [e.kind, e.quantity, e.effective_at]), [['receipt_correction', -5, receipt.received_at]]);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 28, 'correction is at the receipt time: the later count still decides');
  order = corr.body.purchase_order;
  assert.deepEqual([order.status, order.lines[0].quantity_received, order.lines[0].quantity_remaining], ['partially_received', 15, 5],
    'only the corrected quantity reopens');

  const ret = await act(a, order.id, `receipts/${receipt.id}/returns`,
    { idempotency_key: key(), reason: 'Faulty units sent back', returned_at: ago(1),
      lines: [{ receipt_line_id: receipt.lines[0].receipt_line_id, quantity: 3 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 25, 'a return after the count leaves stock now');
  order = ret.body.purchase_order;
  assert.deepEqual([order.lines[0].quantity_received, order.lines[0].quantity_returned, order.lines[0].quantity_remaining], [15, 3, 5],
    'a return does not change the received quantity or the incoming remainder');

  // Corrections + returns never exceed the receipt (20): 5 + 3 used, 12 left.
  const cap = await act(a, order.id, `receipts/${receipt.id}/returns`,
    { idempotency_key: key(), reason: 'x', returned_at: ago(0.5), lines: [{ receipt_line_id: receipt.lines[0].receipt_line_id, quantity: 13 }] });
  assert.deepEqual([cap.status, cap.body.error], [409, 'exceeds_received']);
  const early = await act(a, order.id, `receipts/${receipt.id}/returns`,
    { idempotency_key: key(), reason: 'x', returned_at: ago(9), lines: [{ receipt_line_id: receipt.lines[0].receipt_line_id, quantity: 1 }] });
  assert.equal(early.status, 400, 'nothing can be returned before it was received');
});

test('without a later count a correction reduces stock by the corrected quantity only, once', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  await count(a, a.p.Mouse, 2, ago(10));
  let order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 10 }]));
  order = (await receive(a, order, [[0, 10]], ago(5))).body.purchase_order;
  assert.equal(order.status, 'received');
  const body = { idempotency_key: key(), reason: 'Double-scanned', lines: [{ receipt_line_id: order.receipts[0].lines[0].receipt_line_id, quantity: 4 }] };
  const first = await act(a, order.id, `receipts/${order.receipts[0].id}/corrections`, body);
  const replay = await act(a, order.id, `receipts/${order.receipts[0].id}/corrections`, body);
  assert.deepEqual([first.status, replay.status, replay.body.replayed], [201, 200, true]);
  assert.equal((await item(a, a.p.Mouse)).stock.on_hand, 8, '2 + 10 − 4, never subtracted twice');
  const v = await po(a, order.id);
  assert.deepEqual([v.status, v.completed_at, v.lines[0].quantity_remaining], ['partially_received', null, 4],
    'a corrected order is no longer complete');
  assert.equal((await act(a, order.id, `receipts/${order.receipts[0].id}/corrections`,
    { ...body, lines: [{ receipt_line_id: order.receipts[0].lines[0].receipt_line_id, quantity: 1 }] })).status, 409, 'same id, different change');
});

test('cancelling after a partial receipt keeps received goods and never reopens', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  await count(a, a.p.Mouse, 0, ago(10));
  let order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 10 }], { expected_arrival: karachiDay(3) }));
  order = (await receive(a, order, [[0, 6]], ago(4))).body.purchase_order;
  assert.equal((await act(a, order.id, 'cancel', { version: order.version })).status, 400, 'a reason is required');
  const c = await act(a, order.id, 'cancel', { version: order.version, reason: 'Supplier out of stock' });
  assert.equal(c.status, 200);
  order = c.body.purchase_order;
  assert.deepEqual([order.status, order.lines[0].quantity_received, order.lines[0].quantity_cancelled, order.lines[0].quantity_remaining],
    ['cancelled', 6, 4, 0]);
  let m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.on_hand, m.inbound.open_quantity], [6, 0], 'received stock stays; nothing incoming');
  assert.equal((await receive(a, order, [[0, 1]])).status, 409);
  for (const action of ['approve', 'mark-ordered', 'cancel']) {
    assert.equal((await act(a, order.id, action, { version: order.version, reason: 'x' })).status, 409, `${action} on a cancelled order`);
  }
  assert.equal((await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, expected_arrival: karachiDay(9) })).status, 409);
  // A correction on a cancelled order adjusts what was received only; it does not reopen.
  const corr = await act(a, order.id, `receipts/${order.receipts[0].id}/corrections`,
    { idempotency_key: key(), reason: 'Counted wrong at the door', lines: [{ receipt_line_id: order.receipts[0].lines[0].receipt_line_id, quantity: 2 }] });
  assert.equal(corr.status, 201);
  order = corr.body.purchase_order;
  assert.deepEqual([order.status, order.lines[0].quantity_received, order.lines[0].quantity_remaining], ['cancelled', 4, 0]);
  m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.on_hand, m.inbound.open_quantity], [4, 0]);
});

test('concurrency, editing rules and durable history', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  let order = await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 5 }]);
  assert.equal((await call(a, 'PATCH', `/purchase-orders/${order.id}`, { notes: 'x' })).status, 428, 'a version is required');
  const ok = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, notes: 'first' });
  assert.equal(ok.status, 200);
  const stale = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, notes: 'second' });
  assert.deepEqual([stale.status, stale.body.error], [409, 'version_conflict'], 'a lost update is refused');
  const viaHeader = await ctx.api('POST', `/purchase-orders/${order.id}/approve`, { token: a.token, json: {} });
  assert.equal(viaHeader.status, 428);
  order = await approveAndOrder(a, ok.body.purchase_order);
  const lines = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, lines: [{ product_id: a.p.Mouse, quantity: 9 }] });
  assert.deepEqual([lines.status, lines.body.error], [409, 'not_editable'], 'an ordered order is never edited as a draft');
  let r = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, expected_arrival: karachiDay(4), reason: 'Supplier confirmed' });
  r = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: r.body.purchase_order.version, expected_arrival: karachiDay(6), reason: 'Delayed at port' });
  const arrivals = r.body.purchase_order.events.filter(e => e.event === 'expected_arrival_changed').map(e => [e.detail.from, e.detail.to, e.detail.reason]);
  assert.deepEqual(arrivals, [[null, karachiDay(4), 'Supplier confirmed'], [karachiDay(4), karachiDay(6), 'Delayed at port']]);
  await assert.rejects(ctx.pool.query('UPDATE purchase_order_events SET detail = $1', [{}]), /append-only/);
  await assert.rejects(ctx.pool.query('DELETE FROM purchase_order_events'), /append-only/);
  const receipt = (await receive(a, r.body.purchase_order, [[0, 1]])).body;
  await assert.rejects(ctx.pool.query('UPDATE purchase_receipt_lines SET quantity = 2'), /append-only/);
  await assert.rejects(ctx.pool.query('DELETE FROM purchase_receipts WHERE id = $1', [receipt.receipt_id]), /append-only/);
});

test('currency, unknown costs and links are checked at approval', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1, currency: 'USD', unit_cost: 2 });
  await call(a, 'PUT', `/products/${a.p.Cable}/suppliers/${s1}`, { pack_size: 1 });     // no cost
  const order = await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 5 }, { product_id: a.p.Cable, quantity: 5 }]);
  const r = await act(a, order.id, 'approve', { version: order.version });
  assert.equal(r.status, 422);
  assert.deepEqual(r.body.problems.map(p => p.problem).sort(), ['currency_mismatch', 'unknown_cost']);
  const usd = await call(a, 'PATCH', `/purchase-orders/${order.id}`, { version: order.version, currency: 'USD' });
  const noAck = await act(a, order.id, 'approve', { version: usd.body.purchase_order.version });
  assert.deepEqual(noAck.body.problems.map(p => p.problem), ['unknown_cost']);
  const ack = await act(a, order.id, 'approve', { version: usd.body.purchase_order.version, accept_unknown_costs: true });
  assert.equal(ack.status, 200);
  assert.deepEqual([ack.body.purchase_order.unknown_costs_accepted, ack.body.purchase_order.totals.cost], [true, null]);
  // A product without terms for this supplier cannot be drafted.
  const noLink = await call(a, 'POST', '/purchase-orders', { idempotency_key: key(), supplier_id: s1, lines: [{ product_id: a.p.Lamp, quantity: 1 }] });
  assert.deepEqual([noLink.status, noLink.body.errors[0].problem], [400, 'no_supplier_link']);
  // Draft replay.
  const body = { idempotency_key: key(), supplier_id: s1, lines: [{ product_id: a.p.Mouse, quantity: 1 }] };
  const d1 = await call(a, 'POST', '/purchase-orders', body);
  const d2 = await call(a, 'POST', '/purchase-orders', body);
  assert.deepEqual([d1.status, d2.status, d2.body.purchase_order.id], [201, 200, d1.body.purchase_order.id]);
  assert.equal((await call(a, 'POST', '/purchase-orders', { ...body, lines: [{ product_id: a.p.Mouse, quantity: 2 }] })).status, 409);
});

test('overdue incoming stock is reported separately from on-hand', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  const order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 8 }], { expected_arrival: karachiDay(-2) }));
  const m = await item(a, a.p.Mouse);
  assert.deepEqual([m.stock.known, m.inbound.open_quantity, m.inbound.overdue_quantity, m.readiness.inbound.state], [false, 8, 8, 'overdue']);
  const list = await call(a, 'GET', '/purchase-orders?status=open');
  assert.equal(list.body.purchase_orders.find(p => p.id === order.id).overdue, true);
  const items = await call(a, 'GET', '/inventory/items?state=inbound_overdue');
  assert.deepEqual(items.body.items.map(i => i.name), ['Mouse']);
});

test('another seller can neither read nor change suppliers, orders or receipts', async () => {
  const a = await seller('a@test.com');
  const b = await seller('b@test.com', ['Other']);
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  let order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 4 }]));
  order = (await receive(a, order, [[0, 2]])).body.purchase_order;
  const n = await movements();
  const rl = order.receipts[0].lines[0].receipt_line_id;
  const attempts = [
    ['GET', `/suppliers/${s1}`], ['PATCH', `/suppliers/${s1}`, { name: 'Mine' }],
    ['PUT', `/products/${b.p.Other}/suppliers/${s1}`, {}], ['PUT', `/products/${a.p.Mouse}/suppliers/${s1}`, {}],
    ['GET', `/products/${a.p.Mouse}/suppliers`], ['DELETE', `/products/${a.p.Mouse}/suppliers/${s1}`],
    ['GET', `/purchase-orders/${order.id}`], ['PATCH', `/purchase-orders/${order.id}`, { version: order.version, expected_arrival: null }],
    ['POST', `/purchase-orders/${order.id}/cancel`, { version: order.version, reason: 'x' }],
    ['POST', `/purchase-orders/${order.id}/receipts`, { idempotency_key: key(), received_at: ago(1), lines: [{ line_id: order.lines[0].id, quantity: 1 }] }],
    ['POST', `/purchase-orders/${order.id}/receipts/${order.receipts[0].id}/returns`, { idempotency_key: key(), reason: 'x', returned_at: ago(0.1), lines: [{ receipt_line_id: rl, quantity: 1 }] }],
    ['POST', '/purchase-orders', { idempotency_key: key(), supplier_id: s1, lines: [{ product_id: b.p.Other, quantity: 1 }] }],
  ];
  for (const [method, path, json] of attempts) {
    assert.equal((await call(b, method, path, json)).status, 404, `${method} ${path}`);
  }
  assert.deepEqual((await call(b, 'GET', '/suppliers')).body.suppliers, []);
  assert.deepEqual((await call(b, 'GET', '/purchase-orders')).body.purchase_orders, []);
  assert.equal(await movements(), n);
  assert.equal((await po(a, order.id)).status, 'partially_received');
  // Composite foreign keys: even direct SQL cannot attach B's product to A's order.
  await assert.rejects(ctx.pool.query(
    `INSERT INTO purchase_order_lines (seller_id, po_id, product_id, quantity_ordered, pack_size, min_order_qty) VALUES ($1, $2, $3, 1, 1, 1)`,
    [a.id, order.id, b.p.Other]), /purchase_order_lines_product_fk/);
});

test('manual movements cannot impersonate purchasing', async () => {
  const a = await seller('a@test.com');
  for (const kind of ['receipt', 'receipt_correction', 'supplier_return']) {
    const r = await call(a, 'POST', '/inventory/movements',
      { idempotency_key: key(), product_id: a.p.Mouse, kind, quantity: 1, effective_at: ago(1), reason: 'x' });
    assert.equal(r.status, 400, kind);
  }
  await call(a, 'PATCH', '/inventory/policy', { stale_after_days: 7 });   // creates the default location
  await assert.rejects(ctx.pool.query(
    `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key, content_sha256)
     SELECT $1, $2, id, 'receipt', 5, NOW(), 'k', repeat('0', 64) FROM inventory_locations WHERE seller_id = $1`, [a.id, a.p.Mouse]),
  /stock_movements_receipt_link_check|null value|violates/);
});

// Regression (review 1b): a sales rollback must keep products that purchasing refers to.
test('sales rollback keeps products with supplier terms or on an unreceived purchase order', async () => {
  const s = await registerSeller(ctx.api, 'r@test.com');
  const up = await ctx.api('POST', '/data/upload', { token: s.token, form: csvForm(salesCsv(['Linked', 'OnOrder', 'Plain'], 5, '2026-01-10', false)) });
  assert.equal(up.status, 200);
  const ids = Object.fromEntries((await ctx.pool.query('SELECT id, name FROM products WHERE user_id = $1', [s.id])).rows.map(r => [r.name, r.id]));
  const s1 = await supplier(s);
  await terms(s, ids.Linked, s1, { pack_size: 1, min_order_qty: 1 });
  await terms(s, ids.OnOrder, s1, { pack_size: 1, min_order_qty: 1 });
  const order = await approveAndOrder(s, await draft(s, s1, [{ product_id: ids.OnOrder, quantity: 4 }]));
  // The order must not depend on the link: deactivating it leaves only the order line.
  assert.equal((await call(s, 'DELETE', `/products/${ids.OnOrder}/suppliers/${s1}`)).status, 200);
  await ctx.pool.query('DELETE FROM product_suppliers WHERE product_id = $1', [ids.OnOrder]);

  const rb = await ctx.api('POST', `/data/rollback/${up.body.upload_id}`, { token: s.token });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal(rb.body.rolled_back_rows, 15);
  const left = (await call(s, 'GET', '/products')).body.products.map(p => p.name).sort();
  assert.deepEqual(left, ['Linked', 'OnOrder'], 'only the product nothing refers to is removed');
  const after = await po(s, order.id);
  assert.deepEqual([after.status, after.lines[0].product_name, after.totals.inbound], ['ordered', 'OnOrder', 4]);
  assert.equal((await call(s, 'GET', `/products/${ids.Linked}/suppliers`)).body.links.length, 1);
});

// Regression (review 1b): corrections and returns honour `version` and advance it once.
test('corrections and returns: version checked when sent, advanced once per new adjustment, never by a replay', async () => {
  const a = await seller('a@test.com');
  const s1 = await supplier(a);
  await terms(a, a.p.Mouse, s1, { pack_size: 1, min_order_qty: 1 });
  let order = await approveAndOrder(a, await draft(a, s1, [{ product_id: a.p.Mouse, quantity: 10 }]));
  order = (await receive(a, order, [[0, 8]], ago(5))).body.purchase_order;
  const r = order.receipts[0];
  const rl = r.lines[0].receipt_line_id;
  const path = (k) => `receipts/${r.id}/${k}`;

  const n = await movements();
  const stale = await act(a, order.id, path('corrections'),
    { idempotency_key: key(), reason: 'x', version: order.version - 1, lines: [{ receipt_line_id: rl, quantity: 1 }] });
  assert.deepEqual([stale.status, stale.body.error], [409, 'version_conflict']);
  assert.equal(await movements(), n, 'a stale version records nothing');
  assert.equal((await po(a, order.id)).version, order.version);

  const corrBody = { idempotency_key: key(), reason: 'Miscounted', version: order.version, lines: [{ receipt_line_id: rl, quantity: 1 }] };
  const corr = await act(a, order.id, path('corrections'), corrBody);
  assert.equal(corr.status, 201);
  assert.equal(corr.body.purchase_order.version, order.version + 1, 'one new adjustment, one version step');
  const corrReplay = await act(a, order.id, path('corrections'), corrBody);
  assert.deepEqual([corrReplay.status, corrReplay.body.replayed, corrReplay.body.purchase_order.version],
    [200, true, order.version + 1], 'a replay (even with its now-old version) changes nothing');

  const v1 = corr.body.purchase_order.version;
  const retBody = { idempotency_key: key(), reason: 'Sent back', returned_at: ago(1), lines: [{ receipt_line_id: rl, quantity: 1 }] };
  const ret = await act(a, order.id, path('returns'), retBody);       // no version sent: allowed
  assert.equal(ret.body.purchase_order.version, v1 + 1);
  const retReplay = await act(a, order.id, path('returns'), retBody);
  assert.deepEqual([retReplay.status, retReplay.body.purchase_order.version], [200, v1 + 1]);
  assert.equal((await act(a, order.id, path('returns'),
    { ...retBody, idempotency_key: key(), version: v1 })).status, 409, 'a return with a stale version is refused');

  // Correction on a cancelled order: status stays, version still advances once.
  const c = await act(a, order.id, 'cancel', { version: v1 + 1, reason: 'Closing the order' });
  const vc = c.body.purchase_order.version;
  assert.equal(c.body.purchase_order.status, 'cancelled');
  const onCancelled = { idempotency_key: key(), reason: 'Found a second miscount', version: vc, lines: [{ receipt_line_id: rl, quantity: 1 }] };
  const cc = await act(a, order.id, path('corrections'), onCancelled);
  assert.deepEqual([cc.status, cc.body.purchase_order.status, cc.body.purchase_order.version], [201, 'cancelled', vc + 1]);
  const ccReplay = await act(a, order.id, path('corrections'), onCancelled);
  assert.deepEqual([ccReplay.status, ccReplay.body.purchase_order.version], [200, vc + 1]);
  assert.equal((await act(a, order.id, path('corrections'), { ...onCancelled, idempotency_key: key(), version: 'two' })).status, 400);
});
