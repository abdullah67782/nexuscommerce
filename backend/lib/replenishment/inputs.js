// Stage 2 input loader: gathers every fact the engine needs into plain, serialisable
// objects, and computes the canonical input fingerprint.
//
// Coherence: all database reads for one computation run on ONE client —
//   * readSnapshot(): inside a REPEATABLE READ, READ ONLY transaction, so stock,
//     orders, supplier terms, settings and sales history come from one snapshot;
//   * gather() on a client that already holds the seller's advisory lock (draft
//     creation): every writer of these tables takes the same lock, so nothing can
//     change between the reads.
// Read-only: no INSERT/UPDATE/DELETE here (the location is read, never created).
'use strict';

const crypto = require('node:crypto');
const ledger = require('../stockLedger');
const { assess } = require('../inventoryReadiness');
const { productHistory } = require('../coverage');
const { todayIn, defaultTimezone, stableStringify } = require('../imports');
const forecastService = require('../forecastService');
const { ENGINE_VERSION, ENGINE_VERSION_CALENDAR } = require('./engine');
const calendar = require('../calendar');

const fingerprint = (inputs) => crypto.createHash('sha256').update(stableStringify(inputs)).digest('hex');

async function readSnapshot(pool, sellerId, productIds = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = await gather(client, sellerId, productIds);
    await client.query('COMMIT');
    return snap;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function gather(db, sellerId, productIds = null) {
  const { rows: locs } = await db.query(
    'SELECT id, name, timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  const location = locs[0] || null;
  const timezone = location?.timezone || defaultTimezone();
  const planningDate = todayIn(timezone);

  const { rows: products } = await db.query(
    `SELECT id, name, category FROM products WHERE user_id = $1 AND ($2::int[] IS NULL OR id = ANY($2::int[]))
     ORDER BY lower(name), id`, [sellerId, productIds]);
  const ids = products.map(p => p.id);
  const out = { seller_id: sellerId, location_id: location?.id ?? null, timezone, planning_date: planningDate, products: [] };
  if (!ids.length) return out;

  // Stock (Stage 1a ledger) and the stock state as the Stock tab reports it.
  const pos = location ? await ledger.positions(db, sellerId, location, ids) : new Map();
  const pol = location ? await ledger.policies(db, sellerId, location, ids) : null;

  // Stage 2 settings: product row, else the seller default, else the engine default.
  const settings = location ? (await db.query(
    `SELECT product_id, review_period_days, safety_stock_units FROM inventory_policies
     WHERE seller_id = $1 AND location_id = $2 AND (product_id IS NULL OR product_id = ANY($3::int[]))`,
    [sellerId, location.id, ids])).rows : [];
  const sellerSetting = settings.find(r => r.product_id === null) || {};
  const productSetting = new Map(settings.filter(r => r.product_id !== null).map(r => [r.product_id, r]));

  // Open purchase-order lines (Stage 1b). Only ordered / partially received count as incoming.
  const { rows: lines } = await db.query(
    `SELECT q.po_id, q.product_id, q.status, q.quantity_remaining AS quantity, po.supplier_id,
            to_char(po.expected_arrival, 'YYYY-MM-DD') AS expected_arrival
     FROM purchase_order_line_quantities q JOIN purchase_orders po ON po.id = q.po_id
     WHERE q.seller_id = $1 AND q.product_id = ANY($2::int[]) AND q.quantity_remaining > 0
       AND q.status IN ('draft', 'approved', 'ordered', 'partially_received')
     ORDER BY q.po_id`, [sellerId, ids]);

  // Supplier terms: the preferred active link, else the only active link.
  const { rows: links } = await db.query(
    `SELECT ps.product_id, ps.supplier_id, s.name AS supplier_name, ps.is_preferred, ps.unit_cost::float8 AS unit_cost,
            ps.currency, ps.lead_time_days, ps.pack_size, ps.min_order_qty, s.default_currency
     FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id AND s.seller_id = ps.seller_id
     WHERE ps.seller_id = $1 AND ps.active AND s.active AND ps.product_id = ANY($2::int[])
     ORDER BY ps.product_id, ps.supplier_id`, [sellerId, ids]);

  const salesSince = location ? await salesSinceCount(db, sellerId, location, pos) : new Map();
  // Store calendar (Stage 3a), read in the same snapshot. Off (replenishment-1) unless enabled.
  const cal = calendar.enabled() ? await calendar.readAll(db, sellerId) : null;
  const { rows: maxLead } = cal ? await db.query(
    `SELECT product_id, supplier_id, lead_time_max_days FROM product_suppliers
     WHERE seller_id = $1 AND active AND product_id = ANY($2::int[]) AND lead_time_max_days IS NOT NULL`, [sellerId, ids]) : { rows: [] };
  const ambiguous = location ? await sameInstantEvents(db, sellerId, location, pos) : new Map();

  for (const p of products) {
    const position = pos.get(p.id) || { known: false, legacy: null };
    const policy = pol ? pol.forProduct(p.id) : { stale_after_days: ledger.DEFAULT_STALE_DAYS, reorder_threshold: null };
    const assessed = assess(position, policy);
    const state = assessed.stock.state;
    const productLinks = links.filter(l => l.product_id === p.id);
    const preferred = productLinks.find(l => l.is_preferred);
    const chosen = preferred || (productLinks.length === 1 ? productLinks[0] : null);
    const ps = productSetting.get(p.id) || {};
    const pick = (field) => (ps[field] !== null && ps[field] !== undefined ? { value: ps[field], source: 'product' }
      : sellerSetting[field] !== null && sellerSetting[field] !== undefined ? { value: sellerSetting[field], source: 'seller_default' }
        : { value: null, source: 'default' });
    const review = pick('review_period_days');
    const safety = pick('safety_stock_units');
    const own = lines.filter(l => l.product_id === p.id);
    out.products.push({
      product: p,
      stock: {
        state: state === 'tracked' ? 'last_known' : state,
        on_hand: position.known ? position.on_hand : null,
        counted_at: position.last_count?.observed_at ?? null,
        count_business_date: position.last_count?.business_date ?? null,
        count_age_days: position.last_count?.age_days ?? null,
        stale_after_days: policy.stale_after_days,
        movement_tracking: position.known ? position.movement_tracking : null,
        legacy_quantity: position.legacy?.quantity ?? null,
        // Stage 1a reconciliation, as the Stock tab reports it. The event details are part
        // of the fingerprint, so a newly recorded ambiguity invalidates older recommendations.
        reconciliation: {
          state: assessed.reconciliation.state,
          reason: assessed.reconciliation.state === 'none' ? null : assessed.reconciliation.reason,
          same_instant_events: position.same_instant_events || 0,
          events_without_count: position.events_without_count || 0,
          events: ambiguous.get(p.id) || [],
        },
      },
      sales_since_count: salesSince.get(p.id) || null,
      incoming: own.filter(l => l.status === 'ordered' || l.status === 'partially_received')
        .map(l => ({ po_id: l.po_id, quantity: l.quantity, expected_arrival: l.expected_arrival, status: l.status })),
      not_placed: {
        approved: own.filter(l => l.status === 'approved').map(l => ({ po_id: l.po_id, quantity: l.quantity })),
        drafts: own.filter(l => l.status === 'draft').map(l => ({ po_id: l.po_id, quantity: l.quantity })),
      },
      supplier: !productLinks.length ? { state: 'missing', active_links: 0 }
        : !chosen ? { state: 'choice_needed', active_links: productLinks.length }
          : { state: 'ok', id: chosen.supplier_id, name: chosen.supplier_name, source: preferred ? 'preferred' : 'only_active_link',
            lead_time_days: chosen.lead_time_days, pack_size: chosen.pack_size, min_order_qty: chosen.min_order_qty,
            unit_cost: chosen.unit_cost, currency: chosen.currency || chosen.default_currency, active_links: productLinks.length },
      policy: {
        review_period_days: review.value, review_period_source: review.source === 'default' ? 'default' : review.source,
        safety_stock_units: safety.value, safety_stock_source: safety.source === 'default' ? 'default' : safety.source,
      },
      history: await productHistory(db, sellerId, p.id),
    });
    if (cal) {
      const entry = out.products[out.products.length - 1];
      const supplierId = chosen ? chosen.supplier_id : null;
      const c = calendar.forProduct(cal, p, supplierId, planningDate, 28);
      c.declared_lead_time_max_days = supplierId === null ? null
        : (maxLead.find(r => r.product_id === p.id && r.supplier_id === supplierId)?.lead_time_max_days ?? null);
      // Open orders from the same supplier expected inside a delay you entered: warned, never moved.
      c.incoming_in_supplier_delay = own.filter(l => (l.status === 'ordered' || l.status === 'partially_received') && l.expected_arrival
        && l.supplier_id === supplierId)
        .flatMap(l => c.supplier_delays.filter(e => l.expected_arrival >= e.start_date && l.expected_arrival <= e.end_date)
          .map(e => ({ po_id: l.po_id, expected_arrival: l.expected_arrival, entry_id: e.id, title: e.title, extra_delay_days: e.extra_delay_days })));
      entry.calendar = c;
    }
  }
  return out;
}

// Recorded sales since the count that the stock figure may not reflect, per source
// (design §3.6, decision Q7). Nothing here changes stock: it feeds a labelled scenario.
//   * sales on the count's business date are ambiguous (before or after the count?) —
//     reported, never subtracted;
//   * sales on later days NOT covered by a declared shipment feed are not deducted;
//   * sales on days a declared feed covers are matched against shipment movements
//     recorded from that same source after the count. A declared feed does not prove
//     deduction: covered sales without a matching shipment are included in the
//     scenario and disclosed as unresolved; shipments beyond covered sales are disclosed.
async function salesSinceCount(db, sellerId, location, positions) {
  const counted = [...positions.values()].filter(p => p.known);
  const out = new Map();
  if (!counted.length) return out;
  const pids = counted.map(p => p.product_id);
  const { rows: sales } = await db.query(
    `SELECT a.product_id, a.source_id,
            COALESCE(SUM(a.quantity) FILTER (WHERE a.sale_date = c.count_date), 0)::int AS count_day_units,
            COALESCE(SUM(a.quantity) FILTER (WHERE a.sale_date > c.count_date
              AND COALESCE(f.shipment_feed_since <= (a.sale_date::timestamp AT TIME ZONE $4), FALSE)), 0)::int AS covered_units,
            COALESCE(SUM(a.quantity) FILTER (WHERE a.sale_date > c.count_date
              AND NOT COALESCE(f.shipment_feed_since <= (a.sale_date::timestamp AT TIME ZONE $4), FALSE)), 0)::int AS uncovered_units
     FROM attributed_sales a
     JOIN unnest($2::int[], $3::date[]) AS c(product_id, count_date) ON c.product_id = a.product_id
     LEFT JOIN inventory_source_mappings f ON f.seller_id = $1 AND f.location_id = $5 AND f.source_id = a.source_id
     WHERE a.seller_id = $1 AND a.sale_date >= c.count_date
     GROUP BY a.product_id, a.source_id`,
    [sellerId, pids, counted.map(p => p.last_count.business_date), location.timezone, location.id]);
  const { rows: shipped } = await db.query(
    `SELECT m.product_id, m.source_id, (-SUM(m.quantity))::int AS units
     FROM stock_movements m JOIN unnest($2::int[], $3::timestamptz[]) AS c(product_id, observed_at) ON c.product_id = m.product_id
     WHERE m.seller_id = $1 AND m.location_id = $4 AND m.kind = 'shipment' AND m.effective_at > c.observed_at
     GROUP BY m.product_id, m.source_id`,
    [sellerId, pids, counted.map(p => p.last_count.observed_at), location.id]);
  const { rows: names } = await db.query('SELECT id, display_name, provider FROM data_sources WHERE seller_id = $1', [sellerId]);
  const label = (id) => { const n = names.find(x => x.id === id); return n ? (n.display_name || n.provider) : 'Sales without a source'; };

  for (const p of counted) {
    const mine = sales.filter(s => s.product_id === p.product_id);
    const sourceIds = [...new Set([...mine.map(s => s.source_id), ...shipped.filter(s => s.product_id === p.product_id).map(s => s.source_id)])]
      .sort((a, b) => (a ?? -1) - (b ?? -1));
    const sources = [];
    const unresolved = [];
    let notDeducted = 0;
    let countDay = 0;
    for (const sid of sourceIds) {
      const s = mine.find(x => x.source_id === sid) || { count_day_units: 0, covered_units: 0, uncovered_units: 0 };
      const ship = shipped.find(x => x.product_id === p.product_id && x.source_id === sid)?.units || 0;
      const matched = Math.min(s.covered_units, ship);
      const row = { source_id: sid, source: label(sid), count_day_units: s.count_day_units, uncovered_units: s.uncovered_units,
        covered_units: s.covered_units, shipments_recorded: ship, matched_by_shipments: matched,
        not_deducted_units: s.uncovered_units + (s.covered_units - matched) };
      if (!row.count_day_units && !row.uncovered_units && !row.covered_units && !ship) continue;
      sources.push(row);
      notDeducted += row.not_deducted_units;
      countDay += row.count_day_units;
      if (s.covered_units > matched) {
        unresolved.push({ source_id: sid, kind: 'covered_without_shipment', units: s.covered_units - matched,
          text: `${s.covered_units - matched} unit(s) sold through ${row.source} fall on days its declared shipment feed covers, but no matching shipments are recorded. They may still be shipped, or the feed may be behind; they are included in the scenario.` });
      }
      if (ship > s.covered_units) {
        unresolved.push({ source_id: sid, kind: 'shipments_beyond_covered_sales', units: ship - s.covered_units,
          text: `${ship - s.covered_units} shipped unit(s) from ${row.source} have no covered sale after the count; they may belong to count-day or earlier sales. They are already in the stock figure and are not used again.` });
      }
    }
    if (sources.filter(s => s.not_deducted_units > 0).length > 1) {
      unresolved.push({ kind: 'sources_may_overlap', units: null,
        text: 'Sales from more than one source are added together. If the same orders reach two sources (for example a store and a sales file), they would be counted twice.' });
    }
    if (!sources.length) continue;
    out.set(p.product_id, { units_not_deducted: notDeducted, count_day_units: countDay, sources, unresolved });
  }
  return out;
}

// Movements at exactly the count's instant that the count's own source did not report:
// it cannot be established whether the count already includes them (Stage 1a rule).
async function sameInstantEvents(db, sellerId, location, positions) {
  const flagged = [...positions.values()].filter(p => p.known && p.same_instant_events > 0);
  const out = new Map();
  if (!flagged.length) return out;
  const { rows } = await db.query(
    `SELECT m.product_id, m.id AS movement_id, m.kind, m.quantity, m.source_id, m.effective_at
     FROM stock_movements m
     JOIN unnest($2::int[], $3::int[]) AS c(product_id, snapshot_id) ON c.product_id = m.product_id
     JOIN stock_snapshots s ON s.id = c.snapshot_id
     JOIN stock_snapshot_batches b ON b.id = s.batch_id
     WHERE m.seller_id = $1 AND m.location_id = $4 AND m.effective_at = s.observed_at
       AND (b.source_id IS NULL OR m.source_id IS NULL OR m.source_id <> b.source_id)
     ORDER BY m.product_id, m.id`,
    [sellerId, flagged.map(p => p.product_id), flagged.map(p => p.last_count.snapshot_id), location.id]);
  for (const r of rows) {
    if (!out.has(r.product_id)) out.set(r.product_id, []);
    out.get(r.product_id).push({ movement_id: r.movement_id, kind: r.kind, quantity: r.quantity, source_id: r.source_id,
      effective_at: new Date(r.effective_at).toISOString() });
  }
  return out;
}

// Forecast for one gathered product (via the shared service), mapped to the engine's input.
async function forecastInput(entry) {
  const h = entry.history;
  const hfp = forecastService.historyFingerprint(h);
  // Sale dates are business days in each source's timezone (sources without an import
  // record use the default, as the forecast route does).
  const sourceTimezones = [...new Set((h.sources || []).map(x => x.timezone || defaultTimezone()))].sort();
  if (process.env.FORECAST_V2_ENABLED !== 'true') {
    return { status: 'unavailable', message: 'Forecast v2 is switched off (FORECAST_V2_ENABLED).', history_fingerprint: hfp };
  }
  if (!h.first_sale) return { status: 'no_sales', history_fingerprint: null };
  if (!h.usable) return { status: 'needs_confirmation', history_fingerprint: null };
  let r;
  try {
    r = await forecastService.forecastFromHistory(h, { cache: true });
  } catch (err) {
    return { status: 'unavailable', message: err.message, history_fingerprint: hfp };
  }
  const f7 = (r.forecasts || []).find(f => f.horizon_days === 7);
  const f28 = (r.forecasts || []).find(f => f.horizon_days === 28);
  if (r.history?.tier === 'insufficient' || !f7 || !f28) {
    return { status: 'insufficient', usable_days: r.history?.usable_days ?? h.usable.days, history_fingerprint: hfp };
  }
  return {
    status: 'ok', origin: f7.start, totals: { 7: Number(f7.total_units), 28: Number(f28.total_units) },
    method: f7.method, method_label: f7.method_label || null, pattern_group: r.pattern?.group || null,
    tier: r.history?.tier || null, usable_days: r.history?.usable_days ?? null, models_release: r.models_release || null,
    history_fingerprint: hfp, history_end: h.usable.end, source_timezones: sourceTimezones,
  };
}

// The engine's input for one product. Everything the result depends on is in here,
// so its fingerprint covers: planning date, stock facts, incoming and unplaced orders,
// supplier terms, settings, the forecast's input (history fingerprint) and output
// (release, method, totals), and the engine version.
function engineInputs(snap, entry, forecast, scenario = null) {
  const inputs = {
    engine_version: entry.calendar ? ENGINE_VERSION_CALENDAR : ENGINE_VERSION,
    product_id: entry.product.id,
    location_id: snap.location_id,
    planning_date: snap.planning_date,
    timezone: snap.timezone,
    stock: entry.stock,
    sales_since_count: entry.sales_since_count,
    incoming: entry.incoming,
    not_placed: entry.not_placed,
    supplier: entry.supplier,
    policy: entry.policy,
    forecast,
  };
  if (entry.calendar) inputs.calendar = entry.calendar;
  if (scenario) inputs.scenario = scenario;
  return inputs;
}

module.exports = { readSnapshot, gather, salesSinceCount, forecastInput, engineInputs, fingerprint };
