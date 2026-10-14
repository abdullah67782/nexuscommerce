#!/usr/bin/env node
// DEVELOPMENT smoke test for Stage 2 against a RUNNING backend (after migration 006)
// and a running ML server, with FORECAST_V2_ENABLED=true.
//
//   node scripts/smoke-replenishment.js [api-base]      default http://localhost:5000/api
//
// It registers a fresh, clearly named smoke-test seller (smoke-replenishment-<time>@nexus.local),
// so no existing seller's data is touched, and checks:
//   40 confirmed days at 2 a day (28-day average: 14 / 56) → count 20 → supplier, lead time 7
//   → provisional result, quantity 10 → scenario not saved → draft created → retry returns it
//   → no second draft → a new count makes an older recommendation stale (409, nothing created)
//   → reconciliation: a movement at the count's exact time → indicative, older recommendation refused
//   → timezone: the smoke seller's sales source set to America/Los_Angeles (stock in Asia/Karachi)
//     → needs information, no quantity, older recommendation refused; then set back.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production.');
  process.exit(1);
}
const crypto = require('node:crypto');

const base = process.argv[2] || 'http://localhost:5000/api';
const key = () => crypto.randomUUID();
const TZ = 'Asia/Karachi';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
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
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

(async () => {
  const health = await call('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) throw new Error(`no backend answering at ${base}. Start it with "npm start" first.`);
  const probe = await call('GET', '/inventory/replenishment');
  if (probe.status === 404) {
    throw new Error('the backend on this port is running code from BEFORE Stage 2 (no /inventory/replenishment route). '
      + 'Stop every backend window, make sure nothing listens on port 5000, then start it again.');
  }
  const email = `smoke-replenishment-${Date.now()}@nexus.local`;
  const reg = await call('POST', '/auth/register', { name: 'Smoke Test (replenishment)', email, password: `smoke-${key()}` });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  token = reg.body.token;
  console.log(`Smoke-test seller: ${email} (new, separate from your real sellers). Planning date ${today} (${TZ}).\n`);

  const lines = ['product_name,quantity,sale_date,revenue'];
  for (let i = -40; i <= -1; i += 1) lines.push(`Smoke Lawn,2,${day(i)},200`);
  const form = new FormData();
  form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'smoke.csv');
  for (const [k, v] of Object.entries({ coverage_start: day(-40), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const up = await call('POST', '/data/upload', undefined, form);
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const product = (await call('GET', '/products')).body.products[0].id;
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date(Date.now() - 60000).toISOString(), items: [{ product_id: product, quantity: 20 }] });
  const sup = await call('POST', '/suppliers', { name: 'Smoke Supplier' });
  await call('PUT', `/products/${product}/suppliers/${sup.body.id}`, { unit_cost: 100, currency: 'PKR', lead_time_days: 7, min_order_qty: 1, pack_size: 1 });

  let r = await call('GET', `/inventory/items/${product}/replenishment`);
  if (r.body.status === 'unavailable') {
    throw new Error(`forecast unavailable: ${r.body.forecast?.message}. Start the ML server and set FORECAST_V2_ENABLED=true for the backend.`);
  }
  const rec = r.body;
  check('forecast: 28-day average, starts today, 14 / 56', [rec.forecast.method, rec.forecast.lag_days, rec.forecast.totals[7], rec.forecast.totals[28]], ['average_28', 0, 14, 56]);
  check('outlook covers 7 and 28 days from today', [rec.outlook[7].start, rec.outlook[7].covered_days, rec.outlook[28].end], [today, 7, day(27)]);
  check('provisional: 4 left when usable on day 9, window 14 → order 10',
    [rec.status, rec.actionable, rec.suggestion.stock_when_order_usable, rec.suggestion.quantity], ['provisional', true, 4, 10]);
  check('after the order: no shortage in the window', rec.suggestion.after_order.shortage_in_window, 0);

  r = await call('POST', `/inventory/items/${product}/replenishment/scenario`, { review_period_days: 14 });
  check('scenario (review 14): 24, labelled not saved, not actionable', [r.body.suggestion.quantity, r.body.saved, r.body.actionable], [24, false, false]);
  const pol = await call('GET', `/inventory/items/${product}/policy`);
  check('settings unchanged by the scenario', [pol.body.effective.review_period_days, pol.body.effective.review_period_source], [7, 'default']);

  const body = { recommendation_id: rec.recommendation_id, inputs_sha256: rec.inputs_sha256 };
  r = await call('POST', '/purchase-orders/from-recommendation', body);
  check('draft created from the recommendation', [r.status, r.body.purchase_order?.status, r.body.purchase_order?.lines?.[0]?.quantity_ordered], [201, 'draft', 10]);
  const po = r.body.purchase_order.id;
  r = await call('POST', '/purchase-orders/from-recommendation', body);
  check('retry returns the same draft', [r.status, r.body.replayed, r.body.purchase_order?.id], [200, true, po]);
  r = await call('GET', `/inventory/items/${product}/replenishment`);
  check('no second draft while the draft is unplaced', [r.body.actionable, r.body.draft_blocked?.code], [false, 'unplaced_order_exists']);
  const stock = (await call('GET', `/inventory/items/${product}`)).body.stock.on_hand;
  check('stock unchanged by all of this', stock, 20);

  await call('POST', `/purchase-orders/${po}/cancel`, { version: 1, reason: 'smoke: test draft' });
  r = await call('GET', `/inventory/items/${product}/replenishment`);
  const fresh = r.body;
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date().toISOString(), items: [{ product_id: product, quantity: 15 }] });
  r = await call('POST', '/purchase-orders/from-recommendation', { recommendation_id: fresh.recommendation_id, inputs_sha256: fresh.inputs_sha256 });
  check('after a new count the older recommendation is stale (nothing created)', [r.status, r.body.error, r.body.current?.stock?.on_hand], [409, 'recommendation_stale', 15]);
  const orders = (await call('GET', '/purchase-orders')).body.purchase_orders.length;
  check('only the one (cancelled) draft exists', orders, 1);

  // ── Reconciliation needed (review round 2) ────────────────────────────────
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date().toISOString(), items: [{ product_id: product, quantity: 15 }] });
  const clean = (await call('GET', `/inventory/items/${product}/replenishment`)).body;
  check('reconciliation: starts actionable', [clean.status, clean.actionable, clean.stock.reconciliation?.state], ['provisional', true, 'none']);
  const countedAt = (await call('GET', `/inventory/items/${product}`)).body.stock.last_count.observed_at;
  r = await call('POST', '/inventory/movements', { idempotency_key: key(), kind: 'damage', product_id: product, quantity: 2,
    reason: 'smoke: broken at count time', effective_at: countedAt });
  const item = (await call('GET', `/inventory/items/${product}`)).body;
  check('reconciliation: movement at the count instant → Stock tab needs review', [r.status, item.readiness.reconciliation.state], [201, 'needs_review']);
  const recon = (await call('GET', `/inventory/items/${product}/replenishment`)).body;
  check('reconciliation: indicative, not actionable, fingerprint changed',
    [recon.status, recon.actionable, recon.inputs_sha256 !== clean.inputs_sha256], ['indicative', false, true]);
  r = await call('POST', '/purchase-orders/from-recommendation', { recommendation_id: clean.recommendation_id, inputs_sha256: clean.inputs_sha256 });
  check('reconciliation: older recommendation refused as stale', [r.status, r.body.error], [409, 'recommendation_stale']);
  r = await call('POST', '/purchase-orders/from-recommendation', { recommendation_id: recon.recommendation_id, inputs_sha256: recon.inputs_sha256 });
  check('reconciliation: current recommendation not actionable', [r.status, r.body.error], [409, 'not_actionable']);
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date(Date.now() + 1000).toISOString(), items: [{ product_id: product, quantity: 15 }] });
  const resolved = (await call('GET', `/inventory/items/${product}/replenishment`)).body;
  check('reconciliation: a new count resolves it', [resolved.status, resolved.actionable], ['provisional', true]);

  // ── Timezone mismatch (review round 2), smoke seller's own source only ────
  const source = (await call('GET', '/data/sources')).body.sources[0];
  r = await call('PATCH', `/data/sources/${source.id}`, { timezone: 'America/Los_Angeles' });
  const tz = (await call('GET', `/inventory/items/${product}/replenishment`)).body;
  check('timezone: sales in America/Los_Angeles, stock in Asia/Karachi → needs information',
    [r.status, tz.status, tz.missing?.[0]?.code], [200, 'needs_information', 'timezone_mismatch']);
  check('timezone: no projection, quantity or draft; facts kept',
    [tz.outlook, tz.suggestion, tz.actionable, tz.stock.on_hand, tz.forecast.totals[7], tz.forecast.dates_timezone],
    [null, null, false, 15, 14, 'America/Los_Angeles']);
  r = await call('POST', '/purchase-orders/from-recommendation', { recommendation_id: resolved.recommendation_id, inputs_sha256: resolved.inputs_sha256 });
  check('timezone: older recommendation refused as stale', [r.status, r.body.error], [409, 'recommendation_stale']);
  await call('PATCH', `/data/sources/${source.id}`, { timezone: source.timezone });
  const back = (await call('GET', `/inventory/items/${product}/replenishment`)).body;
  check('timezone: matching again → actionable', [back.status, back.actionable], ['provisional', true]);
  const finalOrders = (await call('GET', '/purchase-orders')).body.purchase_orders.length;
  check('still only the one (cancelled) draft', finalOrders, 1);

  const failed = results.filter(x => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Seller ${email}.`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(`SMOKE TEST ERROR: ${err.message}`); process.exit(1); });
