// Browser evidence for the Inventory AI release (phone / tablet / desktop), captured from the RUNNING app.
//
//   node capture-stage3.mjs [frontend=http://localhost:3000] [api=http://localhost:5000/api]
//
// Creates a fresh, clearly named evidence seller (evidence-stage3-<time>@nexus.local) through the public API, sets up
// the cases to show, then captures full-page screenshots at 390×844, 768×1024 and 1440×900 into ./screens and writes
// ./evidence-log.json (what was set up and what the API answered). No existing seller is touched; nothing is deleted.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FRONT = process.argv[2] || 'http://localhost:3000';
const API = process.argv[3] || 'http://localhost:5000/api';
const OUT = path.resolve('screens');
fs.mkdirSync(OUT, { recursive: true });
const log = { started_at: new Date().toISOString(), frontend: FRONT, api: API, steps: [], shots: [] };
const VIEWPORTS = [['phone', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 900]];
const TZ = 'Asia/Karachi';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const noon = (d) => new Date(Date.parse(`${d}T07:00:00Z`)).toISOString();
const key = () => crypto.randomUUID();
let token;

async function call(method, p, body, form) {
  const res = await fetch(API + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  log.steps.push({ method, path: p, status: res.status, summary: data?.status || data?.error || data?.reason?.code || null });
  if (res.status >= 400 && !(method === 'GET')) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function seed() {
  const email = `evidence-stage3-${Date.now()}@nexus.local`;
  const reg = await call('POST', '/auth/register', { name: 'Evidence Seller', email, password: `ev-${key()}` });
  token = reg.token;
  log.user = reg.user;
  log.seller = email;
  // 210 confirmed days: Mug regular (3/day), Pin rare (every 10th day), Vase dormant (first 20 days only), Jar short (100 days).
  const lines = ['product_name,quantity,sale_date,revenue,category'];
  for (let i = -210; i <= -1; i += 1) {
    lines.push(`Evidence Mug,3,${day(i)},30,Home`);
    if (i % 10 === 0) lines.push(`Evidence Pin,2,${day(i)},20,Crafts`);
    if (i < -190) lines.push(`Evidence Vase,1,${day(i)},50,Home`);
    if (i >= -100) lines.push(`Evidence Jar,1,${day(i)},10,Home`);
  }
  const form = new FormData();
  form.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'evidence.csv');
  for (const [k, v] of Object.entries({ coverage_start: day(-210), coverage_end: day(-1), coverage_scope: 'all_products', coverage_confirmed: 'true' })) form.append(k, v);
  await call('POST', '/data/upload', undefined, form);
  const products = Object.fromEntries((await call('GET', '/products')).products.map(p => [p.name, p.id]));
  log.products = products;
  await call('POST', '/inventory/snapshots', { idempotency_key: key(), observed_at: new Date(Date.now() - 3600000).toISOString(),
    items: [{ product_id: products['Evidence Mug'], quantity: 30 }, { product_id: products['Evidence Pin'], quantity: 4 }] });
  const sup = await call('POST', '/suppliers', { name: 'Evidence Supplier', default_currency: 'USD' });   // orders use one currency; costs are in USD
  for (const name of ['Evidence Mug', 'Evidence Pin']) {
    await call('PUT', `/products/${products[name]}/suppliers/${sup.id}`, { unit_cost: 4, currency: 'USD', lead_time_days: 7, lead_time_max_days: 10, min_order_qty: 1, pack_size: 1 });
  }
  // Two past orders for the supplier view: one delivered 2 days late, one open and late.
  for (const [ordered, receipt] of [[-60, 9], [-20, null]]) {
    const d = await call('POST', '/purchase-orders', { idempotency_key: key(), supplier_id: sup.id, expected_arrival: day(ordered + 7),
      lines: [{ product_id: products['Evidence Mug'], quantity: 12 }] });
    const ap = await call('POST', `/purchase-orders/${d.purchase_order.id}/approve`, { version: d.purchase_order.version });
    const or = await call('POST', `/purchase-orders/${d.purchase_order.id}/mark-ordered`, { version: ap.purchase_order.version, ordered_at: noon(day(ordered)) });
    if (receipt !== null) {
      await call('POST', `/purchase-orders/${d.purchase_order.id}/receipts`, { idempotency_key: key(), received_at: noon(day(ordered + receipt)),
        lines: [{ line_id: or.purchase_order.lines[0].id, quantity: 12 }] });
    }
  }
  return { products, supplierId: sup.id };
}

// The app scrolls inside its own panels (main area, dialogs), so a "full page" screenshot stops at the viewport.
// Grow the viewport height until nothing scrolls vertically (capped), capture, then restore it.
const overflowY = (page) => page.evaluate(() => {
  let extra = 0;
  for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
    if (!el) continue;
    const oy = getComputedStyle(el).overflowY;
    if (el !== document.scrollingElement && oy !== 'auto' && oy !== 'scroll') continue;
    extra = Math.max(extra, el.scrollHeight - el.clientHeight);
  }
  return extra;
});
async function shoot(page, name, { before } = {}) {
  for (const [label, w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    if (before) await before();
    await page.waitForTimeout(1200);
    let height = h;
    for (let i = 0; i < 4; i += 1) {
      const extra = await overflowY(page);
      if (extra <= 2 || height >= 9000) break;
      height = Math.min(9000, height + extra);
      await page.setViewportSize({ width: w, height });
      await page.waitForTimeout(400);
    }
    // Sideways scrolling of the page or a page-level container (tables scrolling inside .table-scroll are intended).
    const horizontal = await page.evaluate(() => {
      let over = document.documentElement.scrollWidth - window.innerWidth;
      for (const el of document.querySelectorAll('*')) {
        if (el.closest('.table-scroll')) continue;
        const ox = getComputedStyle(el).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && el.clientWidth > window.innerWidth * 0.6) over = Math.max(over, el.scrollWidth - el.clientWidth);
      }
      return over;
    });
    const file = path.join(OUT, `${name}-${label}.png`);
    await page.screenshot({ path: file });
    log.shots.push({ name, viewport: label, width: w, captured_height: height, page_horizontal_overflow_px: Math.max(0, horizontal), file: path.basename(file) });
    console.log('captured', path.basename(file), `${w}x${height}`, horizontal > 0 ? `HORIZONTAL OVERFLOW ${horizontal}px` : '');
    await page.setViewportSize({ width: w, height: h });
  }
}

(async () => {
  const { products, supplierId } = await seed();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const host = new URL(FRONT).hostname;
  await context.addCookies([{ name: 'nexus_token', value: token, domain: host, path: '/' }, { name: 'token', value: token, domain: host, path: '/' }]);
  await context.addInitScript(([t, u]) => { localStorage.setItem('nexus_token', t); localStorage.setItem('nexus_user', u); },
    [token, JSON.stringify(log.user || { name: 'Evidence Seller' })]);
  const page = await context.newPage();
  const forecastFor = (name) => async () => {
    await page.goto(`${FRONT}/forecasting`, { waitUntil: 'networkidle' });
    await page.selectOption('#forecast-product', String(products[name]));
    await page.waitForSelector('#ue-title', { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
  };

  // 1. Country not confirmed → reason; 2. US but profile not confirmed → profile step.
  await shoot(page, '01-upper-no-country', { before: forecastFor('Evidence Mug') });
  await call('PUT', '/calendar/settings', { country_code: 'US' });
  await shoot(page, '02-upper-profile-step', { before: forecastFor('Evidence Mug') });
  await call('PUT', '/forecast/upper-estimates/settings', { status: 'confirmed', acknowledge: true });
  await shoot(page, '03-upper-department-step', { before: forecastFor('Evidence Mug') });
  for (const [name, dept] of [['Evidence Mug', 'household'], ['Evidence Pin', 'hobbies'], ['Evidence Vase', 'household'], ['Evidence Jar', 'household']]) {
    await call('PUT', `/forecast/upper-estimates/products/${products[name]}`, { department: dept });
  }
  // 4–5. Eligible regular product at 80% and 90%; 6. rare; 7. short history; 8. dormant.
  await shoot(page, '04-upper-regular-80', { before: forecastFor('Evidence Mug') });
  await shoot(page, '05-upper-regular-90', { before: async () => { await forecastFor('Evidence Mug')(); await page.getByRole('button', { name: '90%' }).click(); } });
  await shoot(page, '06-upper-rare', { before: forecastFor('Evidence Pin') });
  await shoot(page, '07-upper-short-history', { before: forecastFor('Evidence Jar') });
  await shoot(page, '08-upper-dormant', { before: forecastFor('Evidence Vase') });
  for (const name of ['Evidence Mug', 'Evidence Pin', 'Evidence Jar', 'Evidence Vase']) {
    const r = await call('GET', `/forecast/v2/${products[name]}/upper-estimates`);
    log[`upper_${name}`] = { status: r.status, reason: r.reason?.code || null, estimates: (r.estimates || []).map(e => ({ cell: e.cell, method: e.method, upper: e.upper_units, forecast: e.forecast_units })) };
  }
  // Calendar entries, then the calendar tab and the outlook.
  const rec0 = await call('GET', `/inventory/items/${products['Evidence Mug']}/replenishment`);
  await call('POST', '/calendar/entries', { kind: 'demand_scenario', title: 'Back-to-school rush', start_date: day(9), end_date: day(14), demand_change_pct: 40 });
  await call('POST', '/calendar/entries', { kind: 'closure', title: 'Stocktake', start_date: day(4), end_date: day(4) });
  await call('POST', '/calendar/entries', { kind: 'supplier_delay', title: 'Port congestion', start_date: day(0), end_date: day(10), supplier_id: supplierId, extra_delay_days: 2 });
  const rec1 = await call('GET', `/inventory/items/${products['Evidence Mug']}/replenishment`);
  const staleRes = await fetch(`${API}/purchase-orders/from-recommendation`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recommendation_id: rec0.recommendation_id, inputs_sha256: rec0.inputs_sha256 }) });
  log.stale_refusal = { status: staleRes.status, body: await staleRes.json().catch(() => null), fingerprint_changed: rec0.inputs_sha256 !== rec1.inputs_sha256 };
  log.outlook_labels = { applied: (rec1.calendar?.applied || []).map(x => [x.effect, x.label]), supplier_delay: rec1.calendar?.supplier_delay?.label || null,
    holiday_effect_label: rec1.calendar?.holiday_effect_label || null };
  await shoot(page, '09-calendar', { before: async () => { await page.goto(`${FRONT}/inventory?tab=calendar`, { waitUntil: 'networkidle' }); } });
  await shoot(page, '10-outlook', { before: async () => {
    await page.goto(`${FRONT}/inventory?tab=stock`, { waitUntil: 'networkidle' });
    await page.getByLabel('Open Evidence Mug').first().click();
    await page.getByRole('button', { name: 'Outlook' }).first().click().catch(() => {});
    await page.waitForLoadState('networkidle');
  } });
  await shoot(page, '11-supplier-performance', { before: async () => {
    await page.goto(`${FRONT}/inventory?tab=suppliers`, { waitUntil: 'networkidle' });
    await page.getByLabel('Open supplier Evidence Supplier').first().click();
    await page.waitForSelector('[aria-label="Delivery performance"]', { timeout: 20000 }).catch(() => {});
  } });
  await browser.close();
  log.finished_at = new Date().toISOString();
  fs.writeFileSync('evidence-log.json', JSON.stringify(log, null, 2));
  console.log(`\n${log.shots.length} screenshots in ${OUT}. Seller ${log.seller}. Stale refusal: ${log.stale_refusal.status}.`);
})().catch((err) => { fs.writeFileSync('evidence-log.json', JSON.stringify({ ...log, error: String(err) }, null, 2)); console.error('EVIDENCE ERROR:', err.message); process.exit(1); });
