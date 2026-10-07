#!/usr/bin/env node
// Generates the forecasting-milestone demo files (a Pakistan store, Asia/Karachi
// business days) ending on a chosen day:
//
//   node scripts/demo-forecast-data.js <out-dir> [last-day YYYY-MM-DD]
//
// Upload them in order on the Data Integration page, with the coverage shown in
// manifest.json. The four products then show the four history cases:
//   Lawn Suit 3-Piece  regular seller, 240 confirmed days  -> shared model
//   Bridal Clutch      sells on ~9% of days, 240 days      -> rare-sales method (TSB)
//   Ceramic Mug Set    13 days missing (no file covers them) -> 48 days after the gap, average-based
//   Prayer Mat         new, first sold 20 days ago         -> insufficient history
// One wholesale order of 60 suits is included: it is kept and flagged, not removed.
const fs = require('node:fs');
const path = require('node:path');

const [outDir, lastArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node scripts/demo-forecast-data.js <out-dir> [last-day]'); process.exit(1); }
const karachiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
const DAY = 86400000;
const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const end = lastArg || add(karachiToday, -1);

let seed = 20261008;                                   // deterministic pseudo-random numbers
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const poisson = (lambda) => { let k = 0, p = Math.exp(-lambda), s = p; const u = rand(); while (u > s) { k++; p *= lambda / k; s += p; } return k; };

const PRODUCTS = {
  lawn: { name: 'Lawn Suit 3-Piece', category: 'Clothing', price: 4500 },
  clutch: { name: 'Bridal Clutch', category: 'Accessories', price: 7800 },
  mug: { name: 'Ceramic Mug Set', category: 'Home', price: 1800 },
  mat: { name: 'Prayer Mat', category: 'Home', price: 2200 },
};
const first = add(end, -239);
const matLaunch = add(end, -19);

// Orders per product per day (each order 1-3 units).
function ordersFor(key, day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (key === 'lawn') return poisson(dow === 5 || dow === 6 ? 4.2 : 2.8);   // busier Fri/Sat
  if (key === 'clutch') return rand() < 0.09 ? 1 : 0;
  if (key === 'mug') return 1 + poisson(1.4);                              // sells every day
  if (key === 'mat') return day >= matLaunch ? poisson(1.6) : 0;
  return 0;
}
const rows = [];
for (let d = first; d <= end; d = add(d, 1)) {
  for (const key of Object.keys(PRODUCTS)) {
    for (let i = ordersFor(key, d); i > 0; i--) rows.push({ key, day: d, qty: key === 'clutch' ? 1 : 1 + Math.floor(rand() * 3) });
  }
}
rows.push({ key: 'lawn', day: add(first, 100), qty: 60 });  // wholesale order: kept and flagged
const recent = add(end, -60);
if (!rows.some(r => r.key === 'clutch' && r.day >= recent && r.day <= add(end, -2))) rows.push({ key: 'clutch', day: add(end, -30), qty: 1 });

const csv = (list) => ['product_name,category,price,quantity,sale_date,revenue',
  ...list.sort((a, b) => a.day.localeCompare(b.day)).map(r => {
    const p = PRODUCTS[r.key];
    return [p.name, p.category, p.price, r.qty, r.day, (p.price * r.qty).toFixed(2)].join(',');
  })].join('\n') + '\n';

const files = [
  { file: '1_store_export_all_products.csv', rows: rows.filter(r => r.day <= add(end, -61)),
    coverage: { start: first, end: add(end, -61), scope: 'all_products' },
    note: 'Complete export for every product.' },
  { file: '2_store_export_without_mugs.csv', rows: rows.filter(r => r.key !== 'mug' && r.day >= recent && r.day <= add(end, -2)),
    coverage: { start: recent, end: add(end, -2), scope: 'listed_products' },
    note: 'Complete for the products in the file; mug sales were left out of this export.' },
  { file: '3_mug_sales_partial.csv', rows: rows.filter(r => r.key === 'mug' && r.day >= add(end, -47) && r.day <= add(end, -2)),
    coverage: null, note: 'Mug orders found later, only from day -47: no period confirmed, so the 13 days before stay unknown.' },
  { file: '4_no_sales_last_two_days.csv', rows: [],
    coverage: { start: add(end, -1), end, scope: 'all_products' },
    note: 'Zero-transaction export: the shop sold nothing on the last two days (confirmed).' },
];
fs.mkdirSync(outDir, { recursive: true });
for (const f of files) fs.writeFileSync(path.join(outDir, f.file), csv(f.rows));
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  timezone: 'Asia/Karachi', last_day: end, products: Object.values(PRODUCTS).map(p => p.name),
  uploads: files.map(({ rows: r, ...f }) => ({ ...f, rows: r.length })),
}, null, 2) + '\n');
console.log(`Wrote ${files.length} files to ${outDir} (data ends ${end}).`);
