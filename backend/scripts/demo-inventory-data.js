#!/usr/bin/env node
// DEVELOPMENT ONLY (decision D10): records demo inventory for an existing seller
// through the real API. The application never falls back to sample stock; this
// script is the only way demo stock appears, and only when someone runs it.
//
//   node scripts/demo-inventory-data.js <api-base> <email> <password>
//   e.g. node scripts/demo-inventory-data.js http://localhost:5000/api demo@nexus.local secret123
//
// Expects the forecasting demo products (scripts/demo-forecast-data.js). It shows
// every stock state side by side:
//   Lawn Suit 3-Piece  counted yesterday; the connected store sends shipments
//                      → tracked position (count − shipments since)
//   Ceramic Mug Set    counted 2 days ago, one damaged set recorded; becomes a
//                      last-known position as soon as a sales file (which sends
//                      no shipments) records mug sales on/after the count day
//   Prayer Mat         counted ZERO today (a measured zero, not missing stock)
//   Bridal Clutch      counted 12 days ago → stale (tolerance 7 days)
//   Pashmina Shawl     never counted → no count ("unverified only" when the old stock
//                      column left a value); shown as "no count", never 0
// Re-running within the same hour replays (no duplicates); a later re-run the same day is
// refused per item (ids already used) and changes nothing; the next day records new counts.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run with NODE_ENV=production: this script writes demo stock.');
  process.exit(1);
}
const [base, email, password] = process.argv.slice(2);
if (!base || !email || !password) {
  console.error('usage: node scripts/demo-inventory-data.js <api-base> <email> <password>');
  process.exit(1);
}
const HOUR = 3600000;
const anchor = Math.floor(Date.now() / HOUR) * HOUR;   // whole hour: a re-run within the hour replays exactly
const at = (hoursAgo) => new Date(anchor - hoursAgo * HOUR).toISOString();
const day = new Date().toISOString().slice(0, 10);

let token;
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${data.message || data.error || ''}`);
  return data;
}

(async () => {
  token = (await call('POST', '/auth/login', { email, password })).token;
  const { products } = await call('GET', '/products');
  const id = Object.fromEntries(products.map(p => [p.name, p.id]));
  const need = ['Lawn Suit 3-Piece', 'Ceramic Mug Set', 'Prayer Mat', 'Bridal Clutch', 'Pashmina Shawl'];
  const missing = need.filter(n => !id[n]);
  if (missing.length) throw new Error(`Upload the forecasting demo data first (missing: ${missing.join(', ')}).`);

  await call('PATCH', '/inventory/policy', { stale_after_days: 7 });
  const thresholds = { 'Lawn Suit 3-Piece': 40, 'Ceramic Mug Set': 15, 'Prayer Mat': 5, 'Bridal Clutch': 2 };
  for (const [name, t] of Object.entries(thresholds)) await call('PATCH', `/inventory/items/${id[name]}/policy`, { reorder_threshold: t });

  // Counts (each its own submission, with a day-stamped id so a same-day re-run replays).
  const counts = [
    ['Lawn Suit 3-Piece', 64, 20], ['Ceramic Mug Set', 22, 44], ['Prayer Mat', 0, 1], ['Bridal Clutch', 6, 12 * 24],
  ];
  for (const [name, qty, hoursAgo] of counts) {
    const r = await call('POST', '/inventory/snapshots', {
      idempotency_key: `demo-${day}-${name}`, observed_at: at(hoursAgo),
      items: [{ product_id: id[name], quantity: qty }],
    }).catch(e => ({ error: e.message }));
    console.log(`count  ${name.padEnd(18)} ${String(qty).padStart(3)}  ${r.error ? `skipped (${r.error})` : r.replayed ? 'already recorded' : 'recorded'}`);
  }

  // The connected store (if any) sends shipments for this location.
  const { sources } = await call('GET', '/data/sources');
  const store = sources.find(s => s.kind === 'api');
  if (store) {
    await call('PUT', `/inventory/sources/${store.id}`, { reports_physical_on_hand: false, shipment_feed_since: at(24 * 30) });
    const events = [3, 2, 4].map((q, i) => ({
      external_event_id: `demo-${day}-lawn-${i + 1}`, kind: 'shipment', product_id: id['Lawn Suit 3-Piece'],
      quantity: q, effective_at: at(14 - i * 4), order_ref: `DEMO-${i + 1}`,
    }));
    const r = await call('POST', '/inventory/movements', { source_id: store.id, events }).catch(e => ({ error: e.message }));
    console.log(`shipments from "${store.display_name || store.provider}": ${r.error || `${r.recorded} recorded, ${r.replayed} replayed`}`);
  } else {
    console.log('No connected store: Lawn Suit stays a last-known position (no shipment feed).');
  }
  const dmg = await call('POST', '/inventory/movements', {
    idempotency_key: `demo-${day}-mug-damage`, product_id: id['Ceramic Mug Set'], kind: 'damage', quantity: 1,
    effective_at: at(6), reason: 'Broken in the store room',
  }).catch(e => ({ error: e.message }));
  console.log(`damage Ceramic Mug Set 1: ${dmg.error || (dmg.recorded ? 'recorded' : 'already recorded')}`);
  console.log('Pashmina Shawl: intentionally not counted (missing stock).');
})().catch((err) => { console.error(err.message); process.exit(1); });
