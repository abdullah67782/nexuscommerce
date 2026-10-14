#!/usr/bin/env node
// DEVELOPMENT smoke test for the Stage 3 release against a RUNNING backend (after migrations 007 and 008) and the
// REAL ML server, with FORECAST_V2_ENABLED=true, INVENTORY_CALENDAR_ENABLED=true and
// FORECAST_UPPER_ESTIMATES_ENABLED=true.
//
//   node scripts/smoke-stage3.js [api-base]      default http://localhost:5000/api
//
// Registers a fresh smoke-test seller (smoke-stage3-<time>@nexus.local); no existing seller is touched. Checks:
//   upper estimates: unavailable until the country is confirmed; Pakistan → not evaluated; US without the store
//   profile → refused; profile + department → four one-sided estimates beside the SAME forecast; a rare product
//   uses the evaluated rare methods; a dormant and a short-history product get their reasons; answers never
//   change a replenishment fingerprint.
//   calendar: replenishment-2 with labels; a demand change is "assumed by you", a closure / delay is declared;
//   holidays say "Effect unknown"; every change refuses the older recommendation as stale.
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
  const email = `smoke-stage3-${Date.now()}@nexus.local`;
  const reg = await call('POST', '/auth/register', { name: 'Smoke Test (stage 3)', email, password: `smoke-${key()}` });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  token = reg.body.token;
  console.log(`Smoke-test seller: ${email} (new, separate from your real sellers). Today ${today} (${TZ}).\n`);
  const probe = await call('GET', '/forecast/upper-estimates/settings');
  if (probe.status === 404) throw new Error('this backend has no upper-estimate routes: restart it with the new code.');
  if (!probe.body.enabled) throw new Error('set FORECAST_UPPER_ESTIMATES_ENABLED=true and FORECAST_V2_ENABLED=true in backend/.env and restart the backend.');

  // 210 confirmed days: Mug sells 3 every day (regular); Pin sells on every 10th day (rare);
  // Vase sold in the first 20 days only (dormant for the last 180). Jar: 100 days only (short history).
  const lines = ['product_name,quantity,sale_date,revenue,category'];
  for (let i = -210; i <= -1; i += 1) {
    lines.push(`Smoke Mug,3,${day(i)},30,Home`);
    if (i % 10 === 0) lines.push(`Smoke Pin,2,${day(i)},20,Crafts`);
    if (i < -190) lines.push(`Smoke Vase,1,${day(i)},50,Home`);
    if (i >= -100) lines.push(`Smoke Jar,1,${day(i)},10,Home`);
  }
  const form = new FormData();
  form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'smoke-stage3.csv');
  for (const [k, v] of Object.entries({ coverage_start: day(-210), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  const up = await call('POST', '/data/upload', undefined, form);
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const products = Object.fromEntries((await call('GET', '/products')).body.products.map(p => [p.name, p.id]));
  const mug = products['Smoke Mug'];
  const est = (id) => call('GET', `/forecast/v2/${id}/upper-estimates`);

  // ── Upper estimates: applicability ──────────────────────────────────────────
  let r = await est(mug);
  check('no country confirmed → unavailable, forecast untouched', [r.body.status, r.body.reason?.code], ['unavailable', 'country_not_confirmed']);
  await call('PUT', '/calendar/settings', { country_code: 'PK' });
  r = await est(mug);
  check('Pakistan store → not evaluated', r.body.reason?.code, 'market_pakistan');
  await call('PUT', '/calendar/settings', { country_code: 'US' });
  r = await est(mug);
  check('US without the store profile → refused (country alone is not enough)', r.body.reason?.code, 'profile_not_confirmed');
  r = await call('PUT', '/forecast/upper-estimates/settings', { status: 'confirmed', acknowledge: true });
  check('store profile confirmed', [r.status, r.body.status], [200, 'confirmed']);
  r = await est(mug);
  check('product department not chosen → asked for it', r.body.reason?.code, 'product_type_not_set');
  for (const name of ['Smoke Mug', 'Smoke Pin', 'Smoke Vase', 'Smoke Jar']) {
    await call('PUT', `/forecast/upper-estimates/products/${products[name]}`, { department: name === 'Smoke Pin' ? 'hobbies' : 'household' });
  }

  // ── Upper estimates: the real ML service ────────────────────────────────────
  const fc = (await call('GET', `/forecast/v2/${mug}`)).body;
  r = await est(mug);
  const e = r.body.estimates || [];
  check('regular product: four one-sided estimates', [r.body.status, r.body.kind, e.length], ['available', 'one-sided upper demand estimate', 4]);
  check('the forecast beside them is the forecast', JSON.stringify(r.body.forecast?.forecasts) === JSON.stringify(fc.forecasts), true);
  check('regular cells use the evaluated method (U0)', e.map(x => `${x.cell}:${x.method}`),
    ['regular|7|0.8:U0', 'regular|7|0.9:U0', 'regular|28|0.8:U0', 'regular|28|0.9:U0']);
  check('estimates are non-negative and carry dates, coverage and counts',
    e.every(x => x.upper_units >= 0 && x.start && x.end && x.benchmark?.coverage?.value > 0 && x.benchmark?.windows >= 200), true);
  check('no lower estimate in any estimate', e.some(x => Object.keys(x).some(k => k.includes('lower'))), false);
  check('limitation shown', (r.body.limitations || [])[0], 'Evaluated on US Walmart benchmark data; not calibrated to your store.');
  r = await est(products['Smoke Pin']);
  check('rare product: 7-day cells use the rare-sales simulation (U3), 28-day U0/U1',
    [r.body.status, (r.body.estimates || []).map(x => x.method)], ['available', ['U3', 'U3', 'U0', 'U1']]);
  const again = await est(products['Smoke Pin']);
  check('the simulation is repeatable', JSON.stringify(again.body.estimates) === JSON.stringify(r.body.estimates), true);
  check('dormant product → reason, forecast only', (await est(products['Smoke Vase'])).body.reason?.code, 'dormant');
  check('short history → reason, forecast only', (await est(products['Smoke Jar'])).body.reason?.code, 'short_history');

  // ── Calendar + replenishment ────────────────────────────────────────────────
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date(Date.now() - 60000).toISOString(), items: [{ product_id: mug, quantity: 30 }] });
  const sup = await call('POST', '/suppliers', { name: 'Smoke Supplier' });
  await call('PUT', `/products/${mug}/suppliers/${sup.body.id}`, { unit_cost: 100, currency: 'USD', lead_time_days: 7, min_order_qty: 1, pack_size: 1 });
  const r0 = (await call('GET', `/inventory/items/${mug}/replenishment`)).body;
  if (r0.status === 'unavailable') throw new Error(`replenishment unavailable: ${r0.forecast?.message}`);
  check('replenishment-2 with the calendar switched on', [r0.engine_version, Boolean(r0.calendar)], ['replenishment-2', true]);
  await call('PUT', '/forecast/upper-estimates/settings', { status: 'withdrawn', version: 1 });
  const rW = (await call('GET', `/inventory/items/${mug}/replenishment`)).body;
  check('upper-estimate answers never change the replenishment fingerprint', rW.inputs_sha256, r0.inputs_sha256);
  const draft = (x) => call('POST', '/purchase-orders/from-recommendation', { recommendation_id: x.recommendation_id, inputs_sha256: x.inputs_sha256 });
  let older = rW;
  const steps = [
    ['demand change', { kind: 'demand_scenario', title: 'Smoke sale', start_date: day(9), end_date: day(12), demand_change_pct: 40 }, 'assumed_by_seller'],
    ['closure', { kind: 'closure', title: 'Smoke stocktake', start_date: day(3), end_date: day(3) }, 'declared_closure'],
    ['supplier delay', { kind: 'supplier_delay', title: 'Smoke port delay', start_date: day(0), end_date: day(10), supplier_id: sup.body.id, extra_delay_days: 2 }, 'declared_supplier_delay'],
  ];
  for (const [what, body, label] of steps) {
    const c = await call('POST', '/calendar/entries', body);
    check(`${what}: saved with label ${label}`, [c.status, c.body.label], [201, label]);
    const now = (await call('GET', `/inventory/items/${mug}/replenishment`)).body;
    const d = await draft(older);
    check(`${what}: older recommendation refused as stale`, [now.inputs_sha256 !== older.inputs_sha256, d.status, d.body.error], [true, 409, 'recommendation_stale']);
    older = now;
  }
  const cal = (await call('GET', `/calendar?from=${day(0)}&to=${day(120)}`)).body;
  check('holidays say "Effect unknown"', cal.holidays.length > 0 && cal.holidays.every(h => h.effect_label === 'Effect unknown'), true);
  check('outlook labels: demand change assumed, closure declared', [older.calendar.applied.find(x => x.effect === 'demand_change')?.label,
    older.calendar.applied.find(x => x.effect === 'closure')?.label], ['assumed_by_seller', 'declared_by_seller']);
  check('stock unchanged by all of this', (await call('GET', `/inventory/items/${mug}`)).body.stock.on_hand, 30);
  check('no purchase order was created', (await call('GET', '/purchase-orders')).body.purchase_orders.length, 0);

  const failed = results.filter(x => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Seller ${email}.`);
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(`SMOKE TEST ERROR: ${err.message}`); process.exit(1); });
