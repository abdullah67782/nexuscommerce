// Supplier intelligence (lib/supplierPerformance.js): delivery performance from the seller's own orders, timestamp
// quality, censored late orders, the learned-estimate readiness states and their forward-chaining check, seller
// isolation, and that nothing is written.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, registerSeller, csvForm, salesCsv } = require('./helpers');
const { todayIn } = require('../lib/imports');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });
beforeEach(async () => { await ctx.reset(); });

const key = () => crypto.randomUUID();
const TZ = 'Asia/Karachi';
const day = (n) => new Date(Date.parse(`${todayIn(TZ)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const noon = (d) => new Date(Date.parse(`${d}T07:00:00Z`)).toISOString();   // 12:00 in Karachi
const call = (s, method, path, json) => ctx.api(method, path, { token: s.token, json });

async function seller(email) {
  const s = await registerSeller(ctx.api, email);
  assert.equal((await ctx.api('POST', '/data/upload', { token: s.token, form: csvForm(salesCsv(['Mouse', 'Cable'], 10, '2026-01-31', false)) })).status, 200);
  const { rows } = await ctx.pool.query('SELECT id, name FROM products WHERE user_id = $1', [s.id]);
  s.p = Object.fromEntries(rows.map(r => [r.name, r.id]));
  return s;
}
async function supplier(s, name, lead = 7) {
  const r = await call(s, 'POST', '/suppliers', { name });
  assert.equal(r.status, 201);
  const t = await call(s, 'PUT', `/products/${s.p.Mouse}/suppliers/${r.body.id}`, { unit_cost: 10, currency: 'PKR', lead_time_days: lead, min_order_qty: 1, pack_size: 1 });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return r.body.id;
}
// One order: placed on `orderedDay`, promised `promise` days later, receipts [[dayOffsetFromOrder, qty]].
async function order(s, sup, orderedDay, { qty = 10, promise = 7, receipts = [] } = {}) {
  const d = await call(s, 'POST', '/purchase-orders', { idempotency_key: key(), supplier_id: sup,
    expected_arrival: promise === null ? undefined : day(daysFromToday(orderedDay) + promise), lines: [{ product_id: s.p.Mouse, quantity: qty }] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  let r = await call(s, 'POST', `/purchase-orders/${d.body.purchase_order.id}/approve`, { version: d.body.purchase_order.version });
  r = await call(s, 'POST', `/purchase-orders/${d.body.purchase_order.id}/mark-ordered`, { version: r.body.purchase_order.version, ordered_at: noon(orderedDay) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const po = r.body.purchase_order;
  for (const [after, q] of receipts) {
    const at = noon(day(daysFromToday(orderedDay) + after));
    const x = await call(s, 'POST', `/purchase-orders/${po.id}/receipts`, { idempotency_key: key(), received_at: at,
      lines: [{ line_id: po.lines[0].id, quantity: q }] });
    assert.equal(x.status, 201, JSON.stringify(x.body));
  }
  return po;
}
const daysFromToday = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayIn(TZ)}T00:00:00Z`)) / 86400000);
const perf = async (s, id) => (await call(s, 'GET', `/suppliers/${id}/performance`)).body;

test('no orders yet: a clear data-readiness state, declared lead time shown', async () => {
  const s = await seller('a@test.com');
  const sup = await supplier(s, 'Acme', 7);
  const p = await perf(s, sup);
  assert.equal(p.supplier.orders.placed, 0);
  assert.deepEqual(p.supplier.lead_time.declared_days, { min: 7, max: 7, products: 1 });
  assert.equal(p.supplier.learned_estimate.state, 'not_enough_history');
  assert.match(p.supplier.learned_estimate.text, /0 of 8 delivered orders/);
  const all = (await call(s, 'GET', '/suppliers/performance')).body;
  assert.equal(all.suppliers.length, 1);
  assert.equal(all.rules.min_delivered_orders, 8);
});

test('delivery day is the receipt that completes the order; corrections move it, returns do not; late open orders are censored, not dropped', async () => {
  const s = await seller('a@test.com');
  const sup = await supplier(s, 'Acme', 7);
  // Partial on day 5, rest on day 9 (promised 7): delivered day 9, 2 days late, first receipt day 5.
  const a = await order(s, sup, day(-40), { receipts: [[5, 6], [9, 4]] });
  const aa = (await call(s, 'GET', `/purchase-orders/${a.id}`)).body;
  const ret = await call(s, 'POST', `/purchase-orders/${a.id}/receipts/${aa.receipts[1].id}/returns`, { idempotency_key: key(), version: aa.version,
    reason: 'damaged', returned_at: noon(day(-28)), lines: [{ receipt_line_id: aa.receipts[1].lines[0].receipt_line_id, quantity: 2 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.body));
  // Delivered in full on day 6, then 3 units corrected away → complete only with a later receipt on day 12.
  const b = await order(s, sup, day(-30), { receipts: [[6, 10]] });
  const rcpt = (await call(s, 'GET', `/purchase-orders/${b.id}`)).body.receipts[0];
  const c = await call(s, 'POST', `/purchase-orders/${b.id}/receipts/${rcpt.id}/corrections`, { idempotency_key: key(), version: (await call(s, 'GET', `/purchase-orders/${b.id}`)).body.version,
    reason: 'counted wrong', lines: [{ receipt_line_id: rcpt.lines[0].receipt_line_id, quantity: 3 }] });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const bb = (await call(s, 'GET', `/purchase-orders/${b.id}`)).body;
  await call(s, 'POST', `/purchase-orders/${b.id}/receipts`, { idempotency_key: key(), received_at: noon(day(-30 + 12)), lines: [{ line_id: bb.lines[0].id, quantity: 3 }] });
  // Open, promised 7 days after day −20 → late today; and one still within its promise.
  await order(s, sup, day(-20));
  await order(s, sup, day(-2));
  const p = await perf(s, sup);
  const det = Object.fromEntries(p.supplier.order_detail.map(o => [o.po_id, o]));
  assert.deepEqual([det[a.id].state, det[a.id].lead_days, det[a.id].lead_days_first_receipt, det[a.id].days_late, det[a.id].on_time, det[a.id].returned_units],
    ['delivered', 9, 5, 2, false, 2], 'a later supplier return does not undo the delivery date');
  assert.deepEqual([det[b.id].state, det[b.id].lead_days, det[b.id].on_time], ['delivered', 12, false]);
  assert.deepEqual(p.supplier.orders, { placed: 4, delivered: 2, open: 1, open_late: 1, cancelled: 0, excluded_invalid_dates: 0 });
  assert.deepEqual([p.supplier.promises.judged, p.supplier.promises.on_time, p.supplier.promises.late], [3, 0, 3], 'the late open order counts as late');
  assert.deepEqual(p.supplier.lead_time.open_late_days_so_far, [20]);
  assert.equal(p.supplier.lead_time.observed_median_days, 10.5);
  assert.ok(p.supplier.order_detail.every(o => o.issues.includes('order_backdated')), 'orders marked ordered later than their ordered_at are flagged, not dropped');
});

test('timestamp quality: a receipt dated before its order is excluded from statistics', async () => {
  const s = await seller('a@test.com');
  const sup = await supplier(s, 'Acme', 7);
  const good = await order(s, sup, day(-30), { receipts: [[7, 10]] });
  const bad = await order(s, sup, day(-20));
  const x = await call(s, 'POST', `/purchase-orders/${bad.id}/receipts`, { idempotency_key: key(), received_at: noon(day(-25)), lines: [{ line_id: bad.lines[0].id, quantity: 10 }] });
  assert.equal(x.status, 201);
  const p = await perf(s, sup);
  assert.equal(p.supplier.orders.excluded_invalid_dates, 1);
  assert.equal(p.supplier.lead_time.observed_orders, 1);
  assert.ok(p.supplier.order_detail.find(o => o.po_id === bad.id).issues.includes('receipt_before_order'));
  assert.equal(p.supplier.order_detail.find(o => o.po_id === good.id).valid, true);
  assert.equal(p.supplier.timestamp_quality.flags.receipt_before_order, 1);
});

test('learned estimate: shown only when earlier deliveries beat the promise in a forward-chaining check; otherwise the reason', async () => {
  const s = await seller('a@test.com');
  const slow = await supplier(s, 'Always late', 7);        // promises 7, delivers in 10
  const fair = await supplier(s, 'Keeps promises', 7);     // delivers in 6..8 around the promise of 7
  for (let k = 0; k < 9; k += 1) {
    await order(s, slow, day(-200 + 15 * k), { receipts: [[10, 10]] });
    await order(s, fair, day(-200 + 15 * k), { receipts: [[[6, 8, 7][k % 3], 10]] });
  }
  const ps = await perf(s, slow);
  assert.equal(ps.supplier.learned_estimate.state, 'learned_available');
  assert.equal(ps.supplier.learned_estimate.estimate.median_days, 10);
  assert.deepEqual([ps.supplier.learned_estimate.evaluation.evaluated, ps.supplier.learned_estimate.evaluation.mae_learned_days,
    ps.supplier.learned_estimate.evaluation.mae_declared_days], [5, 0, 3]);
  const pf = await perf(s, fair);
  assert.equal(pf.supplier.learned_estimate.state, 'evaluated_not_better');
  assert.ok(pf.supplier.learned_estimate.evaluation.mae_learned_days >= pf.supplier.learned_estimate.evaluation.mae_declared_days);
  // Seven delivered orders: below the minimum, whatever they show.
  const few = await supplier(s, 'New', 7);
  for (let k = 0; k < 7; k += 1) await order(s, few, day(-200 + 15 * k), { receipts: [[10, 10]] });
  assert.equal((await perf(s, few)).supplier.learned_estimate.state, 'not_enough_history');
});

test('read-only, seller-isolated, and replenishment keeps the declared lead time', async () => {
  const s = await seller('a@test.com');
  const other = await seller('b@test.com');
  const sup = await supplier(s, 'Acme', 7);
  for (let k = 0; k < 9; k += 1) await order(s, sup, day(-200 + 15 * k), { receipts: [[10, 10]] });
  const counts = async () => (await ctx.pool.query(`SELECT (SELECT COUNT(*) FROM purchase_orders) + (SELECT COUNT(*) FROM purchase_order_events)
    + (SELECT COUNT(*) FROM stock_movements) + (SELECT COUNT(*) FROM purchase_receipts) AS n`)).rows[0].n;
  const before = await counts();
  assert.equal((await perf(s, sup)).supplier.learned_estimate.state, 'learned_available');
  assert.equal(await counts(), before, 'nothing is written');
  assert.equal((await call(other, 'GET', `/suppliers/${sup}/performance`)).status, 404);
  assert.deepEqual((await call(other, 'GET', '/suppliers/performance')).body.suppliers, []);
  const terms = (await call(s, 'GET', `/products/${s.p.Mouse}/suppliers`)).body;
  assert.equal(JSON.stringify(terms).includes('"lead_time_days":7'), true, 'the declared lead time is unchanged');
});
