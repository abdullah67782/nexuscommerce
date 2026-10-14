// Deterministic plain-language explanation of an engine result. Sentence templates
// filled from the result's own numbers — no language model, no extra inputs.
'use strict';

const n1 = (x) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toFixed(1));
const units = (x) => `${n1(x)} unit${x === 1 ? '' : 's'}`;
const METHOD = { shared_model: 'the shared forecasting model', tsb: 'the rare-sales method (TSB)', average_28: 'the 28-day average' };

function explain(r) {
  const steps = [];
  const add = (title, text) => steps.push({ step: steps.length + 1, title, text });

  // 1. Stock
  if (r.stock.on_hand !== null) {
    add('Stock', `Starting stock is ${units(r.stock.on_hand)}: the count of ${r.stock.count_business_date} plus movements recorded since. `
      + 'It is a last-known figure, not a live one.'
      + (r.stock.reconciliation?.state === 'needs_review' ? ' Some movements at the count\'s exact time may or may not be inside the count, so it needs reconciling.' : '')
      + (r.stock.state === 'stale' ? ` The count is ${r.stock.count_age_days} days old (tolerance ${r.stock.stale_after_days}).` : ''));
  } else {
    add('Stock', 'There is no usable stock count, so stock is unknown (never treated as zero). Only demand can be shown.');
  }

  // 2. Forecast
  const f = r.forecast;
  if (!f || f.status === 'unavailable') {
    add('Forecast', 'The forecast service is not available, so no demand figures are shown. Nothing older or from another method is used instead.');
  } else if (f.status !== 'ok') {
    add('Forecast', 'There is no forecast for this product yet (see Missing information).');
  } else {
    const lag = f.lag_days === null ? `Its dates are in the sales timezone (${f.dates_timezone}), which differs from the stock location's.`
      : f.lag_days === 0 ? `Confirmed sales end yesterday (${f.history_end}), so the forecast starts today.`
      : f.lag_days < 0 ? `Confirmed sales run through ${f.history_end}, so the forecast starts on ${f.origin}, after today.`
        : `Confirmed sales end on ${f.history_end}, so the forecast started on ${f.origin}, ${f.lag_days} day(s) before today. It is never moved to start today.`;
    add('Forecast', `Demand comes from ${METHOD[f.method] || f.method}${f.models_release ? ` (release ${f.models_release})` : ''}: `
      + `${n1(f.totals[7])} units for ${f.blocks[0].start} to ${f.blocks[0].end} and ${n1(f.totals[28])} units for ${f.blocks[1].start} to ${f.blocks[1].end}. ${lag}`);
  }

  // 3. Outlook
  const o = r.outlook;
  if (o) {
    const line = (h) => {
      const x = o[h];
      if (!x.covered_days) return `${h}-day outlook: not covered by the forecast.`;
      let t = `Next ${x.label} (${x.start} to ${x.end}): demand about ${n1(x.demand)}`;
      if (x.stock_at_end !== undefined) t += `, stock at the end about ${n1(x.stock_at_end)}${x.runs_short ? `, about ${n1(x.shortage_units)} unit(s) short` : ', no shortage'}`;
      return `${t}.`;
    };
    const how = o.basis === 'A1' ? 'The totals are spread evenly inside each forecast block (A1).'
      : 'The two forecasts disagree, so each outlook uses its own forecast only.';
    add('Outlook', `${line(7)} ${line(28)} ${how}`
      + (o.approximate_cover_days !== null && o.approximate_cover_days !== undefined ? ` Stock lasts roughly ${o.approximate_cover_days} day(s) under A1 — an approximation, not a date.` : o.cover_note ? ` Days of cover: ${o.cover_note}` : ''));
  } else if (r.outlook_withheld) {
    add('Outlook', r.outlook_withheld.text);
  }

  // 4. Incoming
  const inc = r.incoming;
  const parts = [];
  if (inc.scheduled.length) parts.push(`counted: ${inc.scheduled.map(s => `PO-${s.po_id}: ${units(s.quantity)} usable from ${s.usable_from}`).join('; ')}`);
  if (inc.overdue.length) parts.push(`not counted (overdue): ${inc.overdue.map(s => `PO-${s.po_id}: ${units(s.quantity)}, expected ${s.expected_arrival}`).join('; ')}`);
  if (inc.undated.length) parts.push(`not counted (no date): ${inc.undated.map(s => `PO-${s.po_id}: ${units(s.quantity)}`).join('; ')}`);
  if (inc.approved_not_sent.length) parts.push(`not counted (approved, not ordered): ${inc.approved_not_sent.map(s => `PO-${s.po_id}: ${units(s.quantity)}`).join('; ')}`);
  if (inc.drafts.length) parts.push(`not counted (draft): ${inc.drafts.map(s => `PO-${s.po_id}: ${units(s.quantity)}`).join('; ')}`);
  add('Incoming orders', parts.length ? `${parts.join('. ')}.` : 'No open purchase orders for this product.');

  // 5. Before a new order arrives
  if (r.before_arrival) {
    const b = r.before_arrival;
    add('Before a new order arrives', `With a lead time of ${r.supplier.lead_time_days} day(s), an order placed today is expected on ${b.order_expected} and usable from ${b.order_usable_from}. `
      + (b.runs_short ? `Before then about ${n1(b.shortage_units)} unit(s) of demand cannot be met. A new order cannot prevent this; ask the supplier about a faster delivery.`
        : `Stock is expected to last until then (about ${n1(b.stock_when_order_usable)} left).`));
  }

  // 6. Order quantity
  const s = r.suggestion;
  if (s) {
    let why;
    if (s.binding === 'none') why = `Stock and counted deliveries cover the ${s.window.days}-day review window (${s.window.start} to ${s.window.end})${r.policy.safety_stock_units ? ' and keep the safety stock' : ''}, so no order is needed now.`;
    else if (s.binding === 'safety_stock_at_window_end') why = `To finish the review window (${s.window.start} to ${s.window.end}) with ${r.policy.safety_stock_units} unit(s) of safety stock, ${n1(s.raw_need)} more are needed.`;
    else if (s.binding_detail?.kind === 'before_delivery') why = `Inside the review window (${s.window.start} to ${s.window.end}) stock would run out before ${s.binding_detail.po_ids.map(p => `PO-${p}`).join(', ')} becomes usable on ${s.binding_detail.delivery_usable_from}. Every day of the window is checked, so ${n1(s.raw_need)} more are needed to avoid that gap.`;
    else why = `To avoid a shortage on every day of the review window (${s.window.start} to ${s.window.end}), ${n1(s.raw_need)} more are needed.`;
    const math = s.raw_units === 0 ? '' : ` Whole units: ${s.raw_units}`
      + (s.minimum_adjustment ? `; +${s.minimum_adjustment} to reach the supplier's minimum order of ${r.supplier.min_order_qty}` : '')
      + (s.pack_adjustment ? `; +${s.pack_adjustment} to complete packs of ${r.supplier.pack_size}` : '')
      + ` → ${s.quantity}${s.cost ? ` (${s.cost.currency} ${s.cost.amount.toLocaleString('en-US')})` : ''}.`
      + (s.minimum_adjustment ? ` ${s.minimum_adjustment} of the ${s.quantity} come from the supplier's minimum, not from demand.` : '');
    const after = s.quantity > 0 ? ` With this order: no shortage inside the window, lowest stock about ${n1(s.after_order.lowest_stock_in_window)}, about ${n1(s.after_order.stock_at_window_end)} at the window's end.` : '';
    add('Order quantity', why + math + after + (s.indicative_only ? ' Indicative only — not actionable.' : ''));
  } else if (r.suggestion_withheld) {
    add('Order quantity', `No order quantity: ${r.suggestion_withheld.text}`);
  }
  if (r.alternative_if_uncertain_incoming_arrives) {
    const a = r.alternative_if_uncertain_incoming_arrives;
    add('If uncertain deliveries arrive', `${a.label}, the quantity would be ${a.quantity}. The main suggestion does not assume they arrive.`);
  }
  if (r.sales_adjusted_scenario) {
    const x = r.sales_adjusted_scenario;
    add('Sales since the count', `${x.label} (starting from ${x.starting_stock}), the quantity would be ${x.quantity}. Measured stock is not changed; this is a scenario.`);
  }

  // Store calendar (replenishment-2): what you entered and what it changed. Holidays never change demand.
  if (r.calendar) {
    const c = r.calendar;
    const bits = [];
    for (const x of c.applied) {
      bits.push(x.effect === 'closure' ? `Closed ${x.start_date} to ${x.end_date} ("${x.title}"): no sales and nothing received on ${x.planning_days} planning day(s).`
        : `Your assumption "${x.title}": demand ${x.demand_change_pct > 0 ? '+' : ''}${x.demand_change_pct}% on ${x.planning_days} planning day(s) (${x.start_date} to ${x.end_date}). This is not a prediction.`);
    }
    if (c.supplier_delay) bits.push(c.supplier_delay.text);
    if (c.quantity_without_seller_scenarios) bits.push(`Without your demand changes the quantity would be ${c.quantity_without_seller_scenarios.quantity}.`);
    if (c.late_delivery_scenario) bits.push(c.late_delivery_scenario.withheld ? `${c.late_delivery_scenario.label}: ${c.late_delivery_scenario.withheld}`
      : `${c.late_delivery_scenario.label}: usable from ${c.late_delivery_scenario.usable_from}, about ${n1(c.late_delivery_scenario.shortage_before_usable)} unit(s) short before then, quantity ${c.late_delivery_scenario.quantity}.`);
    if (c.order_by) bits.push(c.order_by.text);
    if (c.holidays.length) bits.push(`Holidays in the next 28 days: ${c.holidays.map(h => `${h.name} ${h.start}${h.status === 'expected' ? ' (expected, not confirmed)' : ''}`).join('; ')}. Their effect on your sales is not known, so the forecast is not changed for them.`);
    else if (!c.country_confirmed) bits.push(c.holiday_note);
    add('Calendar', bits.length ? bits.join(' ') : 'No closure, delay, promotion or demand change you entered affects this product in the next 28 days.');
  }

  // 7. Assumptions, 8. Missing information
  if (r.assumptions.length) add('Assumptions', r.assumptions.map(a => `${a.code}: ${a.text}`).join(' '));
  if (r.missing.length) add('Missing information', r.missing.map(m => `${m.message} → ${m.action}`).join(' '));
  return steps;
}

module.exports = { explain };
