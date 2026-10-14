#!/usr/bin/env node
// DEVELOPMENT smoke test for Stage 1b against a RUNNING backend (after migration 005).
//
//   node scripts/smoke-purchasing.js [api-base]      default http://localhost:5000/api
//
// It registers a fresh, clearly named smoke-test seller (smoke-purchasing-<time>@nexus.local),
// so no existing seller's data is touched, and walks one order through:
//   count → supplier terms → draft → approve → ordered → partial receipt (+ replay)
//   → correction (+ stale version) → supplier return → cancel → receive refused
//   → correction on the cancelled order
// checking on-hand, incoming and the order version at every step. Prints PASS/FAIL.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production.');
  process.exit(1);
}
const crypto = require('node:crypto');

const base = process.argv[2] || 'http://localhost:5000/api';
const key = () => crypto.randomUUID();
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
let token;
const results = [];

async function call(method, path, body, form) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ ok, name, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

(async () => {
  // Pre-flight: a backend still running code from before Stage 1b would answer the
  // stock calls but not purchasing, giving confusing failures later.
  const health = await call('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) throw new Error(`no backend answering at ${base}. Start it with "npm start" first.`);
  const probe = await call('GET', '/suppliers');
  if (probe.status === 404) {
    throw new Error('the backend answering on this port is running code from BEFORE Stage 1b (no /suppliers route). '
      + 'An older "npm start" is probably still running. Stop every backend window, make sure nothing listens on port 5000, then start it again.');
  }
  const email = `smoke-purchasing-${Date.now()}@nexus.local`;
  const reg = await call('POST', '/auth/register', { name: 'Smoke Test (purchasing)', email, password: `smoke-${key()}` });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  token = reg.body.token;
  console.log(`Smoke-test seller: ${email} (new, separate from your real sellers)\n`);

  const form = new FormData();
  form.append('file', new Blob(['product_name,category,price,quantity,sale_date,revenue\nSmoke Lawn,Clothing,100,1,2026-01-05,100\n'], { type: 'text/csv' }), 'smoke.csv');
  const up = await call('POST', '/data/upload', undefined, form);
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const product = (await call('GET', '/products')).body.products[0].id;
  const stock = async () => {
    const res = await call('GET', `/inventory/items/${product}`);
    const i = res.body;
    if (res.status !== 200 || !i.stock || !i.inbound) {
      throw new Error(`GET /inventory/items/${product} returned ${res.status} without ${!i.inbound ? 'incoming (inbound) figures' : 'stock'}: `
        + 'the running backend is not the Stage 1b code. Restart it (stop every backend window first).');
    }
    return { on_hand: i.stock.on_hand, incoming: i.inbound.open_quantity, approved_not_sent: i.inbound.approved_not_sent };
  };

  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: ago(3), items: [{ product_id: product, quantity: 10 }] });
  check('starting count', await stock(), { on_hand: 10, incoming: 0, approved_not_sent: 0 });

  const sup = await call('POST', '/suppliers', { name: 'Smoke Supplier' });
  await call('PUT', `/products/${product}/suppliers/${sup.body.id}`, { unit_cost: 50, currency: 'PKR', lead_time_days: 7, min_order_qty: 10, pack_size: 5 });

  let r = await call('POST', '/purchase-orders', { idempotency_key: key(), supplier_id: sup.body.id, lines: [{ product_id: product, quantity: 22 }] });
  let po = r.body.purchase_order;
  check('draft created (version 1)', [r.status, po.status, po.version], [201, 'draft', 1]);
  r = await call('POST', `/purchase-orders/${po.id}/approve`, { version: po.version });
  check('22 refused: not a multiple of pack size 5 (no rounding)', [r.status, r.body.problems?.[0]?.problem], [422, 'not_a_pack_multiple']);
  r = await call('PATCH', `/purchase-orders/${po.id}`, { version: po.version, lines: [{ product_id: product, quantity: 20 }] });
  po = r.body.purchase_order;
  r = await call('POST', `/purchase-orders/${po.id}/approve`, { version: po.version });
  po = r.body.purchase_order;
  check('approved, version 3', [po.status, po.version], ['approved', 3]);
  check('approval changes no stock', await stock(), { on_hand: 10, incoming: 0, approved_not_sent: 20 });
  r = await call('POST', `/purchase-orders/${po.id}/mark-ordered`, { version: po.version });
  po = r.body.purchase_order;
  check('ordered, version 4', [po.status, po.version], ['ordered', 4]);
  check('ordered: 20 incoming, on-hand unchanged', await stock(), { on_hand: 10, incoming: 20, approved_not_sent: 0 });

  const receipt = { idempotency_key: key(), received_at: ago(1), lines: [{ line_id: po.lines[0].id, quantity: 8 }] };
  r = await call('POST', `/purchase-orders/${po.id}/receipts`, receipt);
  po = r.body.purchase_order;
  check('partial receipt of 8: version 5', [r.status, po.status, po.version], [201, 'partially_received', 5]);
  check('after receipt: on-hand 18, incoming 12', await stock(), { on_hand: 18, incoming: 12, approved_not_sent: 0 });
  r = await call('POST', `/purchase-orders/${po.id}/receipts`, receipt);
  check('receipt replay changes nothing', [r.status, r.body.replayed, r.body.purchase_order.version], [200, true, 5]);
  check('after replay: still 18 / 12', await stock(), { on_hand: 18, incoming: 12, approved_not_sent: 0 });

  const rl = po.receipts[0].lines[0].receipt_line_id;
  const rid = po.receipts[0].id;
  r = await call('POST', `/purchase-orders/${po.id}/receipts/${rid}/corrections`,
    { idempotency_key: key(), reason: 'smoke: stale', version: 4, lines: [{ receipt_line_id: rl, quantity: 2 }] });
  check('correction with a stale version refused', [r.status, r.body.error], [409, 'version_conflict']);
  r = await call('POST', `/purchase-orders/${po.id}/receipts/${rid}/corrections`,
    { idempotency_key: key(), reason: 'smoke: 8 recorded, 6 arrived', version: 5, lines: [{ receipt_line_id: rl, quantity: 2 }] });
  po = r.body.purchase_order;
  check('correction of 2: version 6, received 6', [r.status, po.version, po.lines[0].quantity_received], [201, 6, 6]);
  check('after correction: on-hand 16, incoming 14', await stock(), { on_hand: 16, incoming: 14, approved_not_sent: 0 });

  r = await call('POST', `/purchase-orders/${po.id}/receipts/${rid}/returns`,
    { idempotency_key: key(), reason: 'smoke: 1 faulty sent back', returned_at: new Date().toISOString(), version: 6, lines: [{ receipt_line_id: rl, quantity: 1 }] });
  po = r.body.purchase_order;
  check('return of 1: version 7, received unchanged, returned 1', [r.status, po.version, po.lines[0].quantity_received, po.lines[0].quantity_returned], [201, 7, 6, 1]);
  check('after return: on-hand 15, incoming 14', await stock(), { on_hand: 15, incoming: 14, approved_not_sent: 0 });

  r = await call('POST', `/purchase-orders/${po.id}/cancel`, { version: 7, reason: 'smoke: supplier cannot deliver the rest' });
  po = r.body.purchase_order;
  check('cancel the remainder: version 8, cancelled 14, remaining 0', [po.status, po.version, po.lines[0].quantity_cancelled, po.lines[0].quantity_remaining], ['cancelled', 8, 14, 0]);
  check('after cancel: on-hand kept at 15, nothing incoming', await stock(), { on_hand: 15, incoming: 0, approved_not_sent: 0 });
  r = await call('POST', `/purchase-orders/${po.id}/receipts`, { idempotency_key: key(), received_at: new Date().toISOString(), lines: [{ line_id: po.lines[0].id, quantity: 1 }] });
  check('receiving on a cancelled order refused', [r.status, r.body.error], [409, 'not_receivable']);
  r = await call('POST', `/purchase-orders/${po.id}/receipts/${rid}/corrections`,
    { idempotency_key: key(), reason: 'smoke: correction after cancel', version: 8, lines: [{ receipt_line_id: rl, quantity: 1 }] });
  po = r.body.purchase_order;
  check('correction on the cancelled order: stays cancelled, version 9', [r.status, po.status, po.version, po.lines[0].quantity_remaining], [201, 'cancelled', 9, 0]);
  check('final: on-hand 14, nothing incoming', await stock(), { on_hand: 14, incoming: 0, approved_not_sent: 0 });

  const failed = results.filter(x => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Purchase order PO-${po.id} of ${email}.`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(`SMOKE TEST ERROR: ${err.message}`); process.exit(1); });
