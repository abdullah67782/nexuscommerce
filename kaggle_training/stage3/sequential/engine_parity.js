// Engine parity for the sequential evaluation: every sampled replay decision (D0 or a seller safety stock) is
// recomputed by the application's own engine (backend/lib/replenishment/engine.js, replenishment-1) from the same
// facts. The replay's quantity must equal the engine's EXACTLY.
//
//   node engine_parity.js <sample.jsonl> [<out.json>]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require(path.join(__dirname, '..', '..', '..', 'backend', 'lib', 'replenishment', 'engine.js'));

const D = '2026-01-05';
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function inputs(s) {
  // Planning day k is date D + k − 1; a delivery usable on day k was expected on day k − 1 (A2): date D + k − 2.
  const incoming = Object.entries(s.arrivals).map(([k, q], i) => ({ po_id: 1000 + i, quantity: q, expected_arrival: addDays(D, Number(k) - 2), status: 'ordered' }));
  return {
    product_id: 1, planning_date: D, timezone: 'UTC',
    stock: { state: 'last_known', on_hand: s.on_hand, counted_at: `${D}T00:00:00.000Z`, count_business_date: D, count_age_days: 0,
      stale_after_days: 7, movement_tracking: 'declared_unverified' },
    forecast: { status: 'ok', origin: D, totals: { 7: s.t7, 28: s.t28 }, method: 'shared_model', pattern_group: 'regular', tier: 'model', usable_days: 400 },
    incoming,
    not_placed: { approved: [], drafts: [] },
    supplier: { state: 'ok', id: 1, name: 'S', source: 'preferred', lead_time_days: s.L, pack_size: 1, min_order_qty: 1, unit_cost: 1, currency: 'USD' },
    policy: { review_period_days: s.R, safety_stock_units: s.safety_stock },
    sales_since_count: { units_not_deducted: 0, count_day_units: 0, sources: [] },
  };
}

const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(JSON.parse);
let equal = 0;
const mismatches = [];
for (const s of rows) {
  const r = E.recommend(inputs(s));
  const q = r.suggestion ? r.suggestion.quantity : 0;
  if (q === s.quantity) equal += 1;
  else mismatches.push({ sample: s, engine_quantity: q, engine_status: r.status, withheld: r.suggestion_withheld?.code || null });
}
const out = { engine_version: E.ENGINE_VERSION || 'replenishment-1', decisions: rows.length, equal, mismatches: mismatches.slice(0, 50), mismatch_count: mismatches.length,
  exact: mismatches.length === 0 };
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log(JSON.stringify({ decisions: out.decisions, equal, mismatch_count: out.mismatch_count, exact: out.exact }));
if (mismatches.length) console.log(JSON.stringify(mismatches.slice(0, 3), null, 1));
process.exitCode = mismatches.length ? 1 : 0;
