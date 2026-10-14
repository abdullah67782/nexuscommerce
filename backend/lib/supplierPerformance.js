// Supplier intelligence (Inventory AI, architecture §6C): delivery performance from the seller's own purchase
// records, timestamp quality, declared lead times and delay scenarios, and a data-readiness state for learned
// delivery estimates. Read-only: nothing here changes orders, stock or replenishment (which keeps the declared
// lead time).
//
// Definitions (business dates in the default location's timezone):
//   ordered day      ordered_at as the seller entered it (it may be back-dated);
//   promise          expected_arrival recorded when the order was marked ordered (the 'ordered' event), else the
//                    order's current expected date (flagged 'promise_revised' when they differ);
//   delivered day    the received_at day of the receipt that brought every line to its ordered quantity
//                    (net of cancelled quantities and receipt corrections; supplier returns do not undo delivery).
//                    completed_at is NOT used: it is the time the last receipt was recorded, not when goods arrived.
//   lead time        delivered day − ordered day (and first receipt day − ordered day).
//   open and late    still open after its promised day: a lower bound on the lead time, never dropped and never
//                    counted as on time (censored).
// Timestamp quality (per order):
//   receipt_before_order  a receipt is dated before the order (impossible): the order is EXCLUDED from statistics;
//   order_backdated       the order was marked ordered > 1 day after its ordered_at: kept, flagged;
//   receipt_recorded_late a receipt was recorded > 2 days after its received_at: kept, flagged;
//   no_promise            no expected date: on-time cannot be judged; promise_revised: information.
// Learned delivery estimate (readiness):
//   not_enough_history     fewer than MIN_COMPLETED valid completed orders for the supplier;
//   not_enough_to_evaluate enough orders, but fewer than MIN_EVALUATED orders with ≥ MIN_PRIOR earlier deliveries;
//   evaluated_not_better   forward-chaining back-test: the median of earlier observed lead times was NOT closer to the
//                          actual lead time than the declared/promised one (mean absolute error, strictly lower);
//   learned_available      it was closer: the observed median (range and sample size) is shown as an estimate.
// The minimum counts are a precondition for evaluating, not proof of reliability.
'use strict';

const MIN_COMPLETED = 8;
const MIN_PRIOR = 4;
const MIN_EVALUATED = 4;
const BACKDATE_DAYS = 1;
const LATE_RECORD_DAYS = 2;
const VERSION = 'supplier-performance-1';

const dayIn = (instant, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(instant));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function location(db, sellerId) {
  const { rows } = await db.query('SELECT timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  return rows[0]?.timezone || process.env.DEFAULT_TIMEZONE || 'Asia/Karachi';
}

async function loadOrders(db, sellerId, supplierId) {
  const { rows: orders } = await db.query(
    `SELECT po.id, po.supplier_id, po.status, po.ordered_at, po.cancelled_at,
            to_char(po.expected_arrival, 'YYYY-MM-DD') AS expected_arrival,
            ev.at AS ordered_recorded_at, ev.detail->>'expected_arrival' AS promised_at_order
     FROM purchase_orders po
     LEFT JOIN LATERAL (SELECT e.at, e.detail FROM purchase_order_events e
                        WHERE e.po_id = po.id AND e.seller_id = po.seller_id AND e.event = 'ordered' ORDER BY e.id LIMIT 1) ev ON TRUE
     WHERE po.seller_id = $1 AND po.ordered_at IS NOT NULL AND ($2::int IS NULL OR po.supplier_id = $2)
     ORDER BY po.ordered_at, po.id`, [sellerId, supplierId]);
  if (!orders.length) return [];
  const ids = orders.map(o => o.id);
  const { rows: lines } = await db.query(
    `SELECT line_id, po_id, product_id, quantity_ordered, quantity_cancelled, quantity_returned
     FROM purchase_order_line_quantities WHERE seller_id = $1 AND po_id = ANY($2::int[])`, [sellerId, ids]);
  const { rows: receipts } = await db.query(
    `SELECT r.id, r.po_id, r.received_at, r.recorded_at, rl.po_line_id,
            (rl.quantity - COALESCE((SELECT SUM(a.quantity) FROM purchase_receipt_adjustments a
                                     WHERE a.receipt_line_id = rl.id AND a.kind = 'correction'), 0))::int AS net
     FROM purchase_receipts r JOIN purchase_receipt_lines rl ON rl.receipt_id = r.id
     WHERE r.seller_id = $1 AND r.po_id = ANY($2::int[])
     ORDER BY r.received_at, r.id`, [sellerId, ids]);
  return orders.map(o => ({ ...o, lines: lines.filter(l => l.po_id === o.id), receipts: receipts.filter(r => r.po_id === o.id) }));
}

function analyseOrder(o, tz, today) {
  const issues = [];
  const orderedDay = dayIn(o.ordered_at, tz);
  const promise = o.promised_at_order || o.expected_arrival || null;
  if (!promise) issues.push('no_promise');
  if (o.promised_at_order && o.expected_arrival && o.promised_at_order !== o.expected_arrival) issues.push('promise_revised');
  if (o.ordered_recorded_at && (Date.parse(o.ordered_recorded_at) - Date.parse(o.ordered_at)) / 86400000 > BACKDATE_DAYS) issues.push('order_backdated');
  if (o.receipts.some(r => Date.parse(r.received_at) < Date.parse(o.ordered_at))) issues.push('receipt_before_order');
  if (o.receipts.some(r => (Date.parse(r.recorded_at) - Date.parse(r.received_at)) / 86400000 > LATE_RECORD_DAYS)) issues.push('receipt_recorded_late');

  const need = new Map(o.lines.map(l => [l.line_id, l.quantity_ordered - l.quantity_cancelled]));
  const got = new Map(o.lines.map(l => [l.line_id, 0]));
  let deliveredAt = null;
  const byReceipt = [...new Set(o.receipts.map(r => r.id))].map(id => o.receipts.filter(r => r.id === id));
  for (const rs of byReceipt) {
    for (const r of rs) got.set(r.po_line_id, (got.get(r.po_line_id) || 0) + r.net);
    if (!deliveredAt && [...need].every(([id, q]) => q <= 0 || (got.get(id) || 0) >= q) && [...need.values()].some(q => q > 0)) {
      deliveredAt = rs[0].received_at;
    }
  }
  const firstAt = o.receipts.find(r => r.net > 0)?.received_at || null;
  const orderedUnits = [...need.values()].reduce((s, q) => s + Math.max(q, 0), 0);
  const receivedUnits = [...got.values()].reduce((s, q) => s + q, 0);
  const returnedUnits = o.lines.reduce((s, l) => s + l.quantity_returned, 0);
  let state;
  if (deliveredAt) state = 'delivered';
  else if (o.status === 'cancelled') state = receivedUnits > 0 ? 'cancelled_after_partial' : 'cancelled';
  else state = promise && today > promise ? 'open_late' : 'open';
  const deliveredDay = deliveredAt ? dayIn(deliveredAt, tz) : null;
  return {
    po_id: o.id, supplier_id: o.supplier_id, status: o.status, state, ordered_day: orderedDay, promised_day: promise,
    first_receipt_day: firstAt ? dayIn(firstAt, tz) : null, delivered_day: deliveredDay,
    lead_days: deliveredDay ? daysBetween(orderedDay, deliveredDay) : null,
    lead_days_first_receipt: firstAt ? daysBetween(orderedDay, dayIn(firstAt, tz)) : null,
    promised_lead_days: promise ? daysBetween(orderedDay, promise) : null,
    days_late: deliveredDay && promise ? Math.max(0, daysBetween(promise, deliveredDay))
      : state === 'open_late' ? daysBetween(promise, today) : null,
    open_days_so_far: state.startsWith('open') ? daysBetween(orderedDay, today) : null,
    on_time: deliveredDay && promise ? deliveredDay <= promise : state === 'open_late' ? false : null,
    ordered_units: orderedUnits, received_units: receivedUnits, returned_units: returnedUnits,
    issues, valid: !issues.includes('receipt_before_order'),
  };
}

// Forward-chaining back-test: each delivered order is predicted from the deliveries completed before it was placed.
function evaluate(delivered, declaredFor) {
  const rows = [];
  for (const o of delivered) {
    const prior = delivered.filter(p => p !== o && p.delivered_day < o.ordered_day);
    if (prior.length < MIN_PRIOR) continue;
    const declared = o.promised_lead_days ?? declaredFor(o);
    if (declared === null || declared === undefined) continue;
    rows.push({ po_id: o.po_id, actual: o.lead_days, learned: median(prior.map(p => p.lead_days)), declared });
  }
  if (rows.length < MIN_EVALUATED) return { rows, evaluated: rows.length, passed: null };
  const mae = (k) => rows.reduce((s, r) => s + Math.abs(r[k] - r.actual), 0) / rows.length;
  const learnedMae = mae('learned');
  const declaredMae = mae('declared');
  return { rows, evaluated: rows.length, mae_learned_days: learnedMae, mae_declared_days: declaredMae, passed: learnedMae < declaredMae,
    learned_closer: rows.filter(r => Math.abs(r.learned - r.actual) < Math.abs(r.declared - r.actual)).length };
}

function summarise(supplier, orders, terms, delays) {
  const valid = orders.filter(o => o.valid);
  const delivered = valid.filter(o => o.state === 'delivered').sort((a, b) => a.ordered_day.localeCompare(b.ordered_day) || a.po_id - b.po_id);
  const late = valid.filter(o => o.state === 'open_late');
  const judged = valid.filter(o => o.on_time !== null);
  const leads = delivered.map(o => o.lead_days);
  const declared = terms.map(t => t.lead_time_days).filter(x => x !== null);
  const declaredSlowest = terms.map(t => t.lead_time_max_days).filter(x => x !== null && x !== undefined);
  const declaredFor = () => (declared.length ? Math.max(...declared) : null);   // used only when the order has no promise
  const flags = {};
  for (const o of orders) for (const i of o.issues) flags[i] = (flags[i] || 0) + 1;

  let learned;
  const ev = delivered.length >= MIN_COMPLETED ? evaluate(delivered, declaredFor) : null;
  if (delivered.length < MIN_COMPLETED) {
    learned = { state: 'not_enough_history', text: `Not enough delivery history: ${delivered.length} of ${MIN_COMPLETED} delivered orders with valid dates. The declared lead time is used.` };
  } else if (ev.passed === null) {
    learned = { state: 'not_enough_to_evaluate', evaluation: { evaluated: ev.evaluated, required: MIN_EVALUATED },
      text: `${delivered.length} delivered orders, but only ${ev.evaluated} can be checked against earlier deliveries (${MIN_EVALUATED} needed). The declared lead time is used.` };
  } else if (!ev.passed) {
    learned = { state: 'evaluated_not_better', evaluation: { evaluated: ev.evaluated, mae_learned_days: ev.mae_learned_days, mae_declared_days: ev.mae_declared_days },
      text: `In a check on ${ev.evaluated} past orders, earlier deliveries did not predict the delivery time better than the declared/promised lead time. The declared lead time is used.` };
  } else {
    const sorted = [...leads].sort((a, b) => a - b);
    learned = { state: 'learned_available', estimate: { median_days: median(leads), min_days: sorted[0], max_days: sorted[sorted.length - 1], orders: leads.length },
      evaluation: { evaluated: ev.evaluated, mae_learned_days: ev.mae_learned_days, mae_declared_days: ev.mae_declared_days, learned_closer: ev.learned_closer },
      open_later_than_estimate: late.filter(o => o.open_days_so_far > median(leads)).length,
      text: `Observed delivery time ${median(leads)} day(s) (range ${sorted[0]}–${sorted[sorted.length - 1]}, ${leads.length} orders). In a check on ${ev.evaluated} past orders it was closer to the actual time than the declared lead time on average. It is shown for information; reorder suggestions still use the declared lead time.` };
  }
  return {
    supplier_id: supplier.id, name: supplier.name, version: VERSION,
    orders: {
      placed: orders.length, delivered: delivered.length, open: valid.filter(o => o.state === 'open').length, open_late: late.length,
      cancelled: valid.filter(o => o.state === 'cancelled' || o.state === 'cancelled_after_partial').length,
      excluded_invalid_dates: orders.length - valid.length,
    },
    lead_time: {
      declared_days: declared.length ? { min: Math.min(...declared), max: Math.max(...declared), products: declared.length } : null,
      declared_slowest_days: declaredSlowest.length ? Math.max(...declaredSlowest) : null,
      observed_median_days: median(leads), observed_min_days: leads.length ? Math.min(...leads) : null,
      observed_max_days: leads.length ? Math.max(...leads) : null, observed_orders: leads.length,
      first_receipt_median_days: median(delivered.map(o => o.lead_days_first_receipt).filter(x => x !== null)),
      open_late_days_so_far: late.map(o => o.open_days_so_far),
    },
    promises: {
      judged: judged.length, on_time: judged.filter(o => o.on_time).length,
      late: judged.filter(o => o.on_time === false).length,
      median_days_late: median(judged.filter(o => o.on_time === false && o.state === 'delivered').map(o => o.days_late)),
      without_promise: valid.filter(o => o.promised_day === null).length,
      note: 'Open orders past their promised day count as late (they are not dropped).',
    },
    quantities: {
      ordered_units: delivered.concat(valid.filter(o => o.state === 'cancelled_after_partial')).reduce((s, o) => s + o.ordered_units, 0),
      received_units: delivered.concat(valid.filter(o => o.state === 'cancelled_after_partial')).reduce((s, o) => s + o.received_units, 0),
      returned_units: valid.reduce((s, o) => s + o.returned_units, 0),
    },
    timestamp_quality: { flags, orders_with_flags: orders.filter(o => o.issues.some(i => i !== 'promise_revised' && i !== 'no_promise')).length },
    delay_scenarios: {
      declared_slowest_days: declaredSlowest.length ? Math.max(...declaredSlowest) : null,
      calendar_delays: delays.map(d => ({ id: d.id, title: d.title, start_date: d.start_date, end_date: d.end_date, extra_delay_days: d.extra_delay_days })),
      text: 'Reorder suggestions use the declared lead time. Delay scenarios: the supplier\'s declared slowest time (shown on each product\'s outlook) and supplier delays you enter on the calendar.',
    },
    learned_estimate: learned,
  };
}

async function performance(db, sellerId, { supplierId = null, withOrders = false } = {}) {
  const tz = await location(db, sellerId);
  const today = dayIn(Date.now(), tz);
  const { rows: suppliers } = await db.query(
    `SELECT id, name, active FROM suppliers WHERE seller_id = $1 AND ($2::int IS NULL OR id = $2) ORDER BY active DESC, lower(name)`, [sellerId, supplierId]);
  const { rows: terms } = await db.query(
    `SELECT supplier_id, product_id, lead_time_days, lead_time_max_days FROM product_suppliers WHERE seller_id = $1 AND active`, [sellerId]);
  const { rows: delays } = await db.query(
    `SELECT id, supplier_id, title, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, extra_delay_days
     FROM calendar_entries WHERE seller_id = $1 AND kind = 'supplier_delay' AND status = 'active' AND end_date >= $2::date ORDER BY start_date`, [sellerId, today]);
  const orders = (await loadOrders(db, sellerId, supplierId)).map(o => analyseOrder(o, tz, today));
  const out = suppliers.map(s => {
    const mine = orders.filter(o => o.supplier_id === s.id);
    const sum = summarise(s, mine, terms.filter(t => t.supplier_id === s.id), delays.filter(d => d.supplier_id === s.id));
    return withOrders ? { ...sum, order_detail: mine } : sum;
  });
  return { as_of: today, timezone: tz, version: VERSION,
    rules: { min_delivered_orders: MIN_COMPLETED, min_prior_deliveries: MIN_PRIOR, min_evaluated_orders: MIN_EVALUATED,
      backdated_after_days: BACKDATE_DAYS, receipt_recorded_late_after_days: LATE_RECORD_DAYS },
    suppliers: out };
}

module.exports = { performance, analyseOrder, evaluate, summarise, MIN_COMPLETED, MIN_PRIOR, MIN_EVALUATED, VERSION };
