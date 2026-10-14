// Stage 2 replenishment API (mounted at /api). Advisory only.
//
//   GET  /inventory/replenishment                       action queue (counts across ALL products)
//   GET  /inventory/items/:id/replenishment             full result for one product
//   POST /inventory/items/:id/replenishment/scenario    what-if, NOT saved, policy unchanged
//   POST /purchase-orders/from-recommendation           seller-initiated DRAFT only
//
// Nothing here writes stock, approves or sends an order, or changes a setting. The
// only writes are the append-only recommendation log and, on the seller's request,
// a draft order (which then follows every Stage 1b rule). The seller comes from the
// token; another seller's ids answer 404.
'use strict';

const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { lockSeller } = require('../lib/imports');
const P = require('../lib/purchasing');
const engine = require('../lib/replenishment/engine');
const { explain } = require('../lib/replenishment/explain');
const I = require('../lib/replenishment/inputs');

const { InventoryError } = P;
const router = express.Router();

const fail = (res, err, what) => {
  if (err instanceof InventoryError) return res.status(err.status).json(err.body);
  console.error(`Replenishment ${what} error:`, err.message);
  return res.status(500).json({ error: 'server_error', message: `Error ${what}.` });
};
const notFound = () => new InventoryError(404, { error: 'not_found', message: 'Product not found.' });
const ownId = (raw) => { const id = Number(raw); return Number.isInteger(id) && id > 0 ? id : null; };

// One product: snapshot entry → forecast → engine → explanation.
async function compute(snap, entry, scenario = null) {
  const forecast = await I.forecastInput(entry);
  let inputs = I.engineInputs(snap, entry, forecast);
  if (scenario) inputs = applyScenario(inputs, scenario);
  const result = engine.recommend(inputs);
  result.explanation = explain(result);
  return { inputs, sha: I.fingerprint(inputs), result };
}

// Append-only log (decision Q10): one row per product, planning day, engine version and
// input fingerprint. 'unavailable' results (no forecast) and scenarios are not logged.
async function log(db, snap, entry, c) {
  if (c.result.status === 'unavailable' || !snap.location_id) return null;
  const r = c.result;
  const params = [snap.seller_id, entry.product.id, snap.location_id, snap.planning_date, r.engine_version, c.sha, r.status,
    r.actionable, r.suggestion ? r.suggestion.quantity : null, r.supplier.state === 'ok' ? r.supplier.id : null,
    r.forecast?.models_release || null, r.forecast?.origin || null, JSON.stringify(c.inputs), JSON.stringify(r)];
  const { rows } = await db.query(
    `INSERT INTO replenishment_recommendations (seller_id, product_id, location_id, planning_date, engine_version, inputs_sha256,
       status, actionable, suggested_quantity, supplier_id, models_release, forecast_origin, inputs, output)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT ON CONSTRAINT replenishment_recommendations_identity_uq DO NOTHING RETURNING id`, params);
  if (rows.length) return rows[0].id;
  const { rows: prior } = await db.query(
    `SELECT id FROM replenishment_recommendations WHERE seller_id = $1 AND product_id = $2 AND planning_date = $3
       AND engine_version = $4 AND inputs_sha256 = $5`, [snap.seller_id, entry.product.id, snap.planning_date, c.result.engine_version, c.sha]);
  return prior[0]?.id ?? null;
}

async function draftFor(db, sellerId, recommendationId) {
  if (!recommendationId) return null;
  const { rows } = await db.query(
    `SELECT id, status, version FROM purchase_orders
     WHERE seller_id = $1 AND source_recommendation_id = $2 AND status <> 'cancelled'`, [sellerId, recommendationId]);
  return rows[0] || null;
}

function detail(entry, c, recommendationId, draft) {
  return {
    product: entry.product,
    recommendation_id: recommendationId,
    inputs_sha256: c.sha,
    draft_order: draft ? { id: draft.id, status: draft.status } : null,
    ...c.result,
  };
}

// ── Queue ────────────────────────────────────────────────────────────────────
const QUEUE_STATES = ['needs_information', 'shortage_before_arrival', 'shortage_within_7', 'order_suggested', 'indicative', 'unavailable'];
const rank = (x) => (x.before_arrival_shortage > 0 ? 0 : x.actionable ? 1 : x.shortage_within_7 ? 2 : x.status === 'needs_information' ? 3
  : x.status === 'indicative' ? 4 : x.status === 'unavailable' ? 5 : 6);

function nextStep(r) {
  if (r.status === 'unavailable') return 'Forecast service unavailable — try again later.';
  if (r.missing.length) return r.missing[0].action;
  if (r.indicative_reasons.length) {
    const code = r.indicative_reasons[0].code;
    return code === 'stock_stale' ? 'Record a new stock count.'
      : code === 'stock_needs_reconciliation' ? 'Check the movements at the count time, or recount.'
      : code === 'forecast_lag' ? 'Upload and confirm recent sales.'
        : code === 'forecast_horizons_inconsistent' ? 'Check recent sales; the forecasts disagree.'
          : 'Check again tomorrow.';
  }
  if (r.draft_blocked) return `Review ${r.draft_blocked.po_ids.map(id => `PO-${id}`).join(', ')} (not placed yet).`;
  if (r.actionable) return 'Review the suggestion and create a draft order.';
  return 'No order needed now.';
}

router.get('/inventory/replenishment', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const state = req.query.state ? String(req.query.state) : null;
    if (state && !QUEUE_STATES.includes(state)) throw P.bad(`state must be one of: ${QUEUE_STATES.join(', ')}.`);
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
    const pageSize = Math.min(100, Math.max(1, Number(req.query.page_size) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);

    const snap = await I.readSnapshot(pool, sellerId);
    // Forecast calls are bounded inside the forecast service (ML_V2_CONCURRENCY).
    const computed = await Promise.all(snap.products.map(entry => compute(snap, entry).then(c => ({ entry, c }))));
    const rows = [];
    for (const { entry, c } of computed) {
      const id = await log(pool, snap, entry, c);
      const r = c.result;
      rows.push({
        product: entry.product,
        recommendation_id: id,
        inputs_sha256: c.sha,
        status: r.status,
        actionable: r.actionable,
        shortage_within_7: Boolean(r.outlook?.[7]?.runs_short),
        shortage_7_units: r.outlook?.[7]?.shortage_units ?? null,
        shortage_28_units: r.outlook?.[28]?.shortage_units ?? null,
        covered_days_28: r.outlook?.[28]?.covered_days ?? null,
        before_arrival_shortage: r.before_arrival?.shortage_units ?? null,
        suggested_quantity: r.suggestion ? r.suggestion.quantity : null,
        suggestion_indicative: Boolean(r.suggestion?.indicative_only),
        suggestion_withheld: r.suggestion_withheld?.code || null,
        stock: { state: r.stock.state, on_hand: r.stock.on_hand, count_age_days: r.stock.count_age_days },
        forecast: r.forecast ? { status: r.forecast.status, method: r.forecast.method || null, lag_days: r.forecast.lag_days ?? null } : null,
        warnings: r.warnings.map(w => w.code),
        next_step: nextStep(r),
      });
    }
    const counts = {
      total: rows.length,
      needs_information: rows.filter(x => x.status === 'needs_information').length,
      shortage_before_arrival: rows.filter(x => x.before_arrival_shortage > 0).length,
      shortage_within_7: rows.filter(x => x.shortage_within_7).length,
      order_suggested: rows.filter(x => x.actionable).length,
      indicative: rows.filter(x => x.status === 'indicative').length,
      provisional: rows.filter(x => x.status === 'provisional').length,
      unavailable: rows.filter(x => x.status === 'unavailable').length,
    };
    const match = (x) => !state
      || (state === 'needs_information' && x.status === 'needs_information')
      || (state === 'shortage_before_arrival' && x.before_arrival_shortage > 0)
      || (state === 'shortage_within_7' && x.shortage_within_7)
      || (state === 'order_suggested' && x.actionable)
      || (state === 'indicative' && x.status === 'indicative')
      || (state === 'unavailable' && x.status === 'unavailable');
    const filtered = rows.filter(x => match(x) && (!q || x.product.name.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.product.name.localeCompare(b.product.name) || a.product.id - b.product.id);
    res.json({
      planning_date: snap.planning_date, timezone: snap.timezone,
      engine_version: require('../lib/calendar').enabled() ? engine.ENGINE_VERSION_CALENDAR : engine.ENGINE_VERSION,
      forecast_service: counts.unavailable ? 'unavailable' : 'ok',
      forecast_service_message: computed.find(x => x.c.result.status === 'unavailable')?.c.result.forecast.message || null,
      counts,
      page, page_size: pageSize, total: filtered.length,
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
    });
  } catch (err) { fail(res, err, 'building the replenishment queue'); }
});

// ── One product ──────────────────────────────────────────────────────────────
async function productDetail(sellerId, productId) {
  const snap = await I.readSnapshot(pool, sellerId, [productId]);
  const entry = snap.products[0];
  if (!entry) throw notFound();
  const c = await compute(snap, entry);
  const id = await log(pool, snap, entry, c);
  return detail(entry, c, id, await draftFor(pool, sellerId, id));
}

router.get('/inventory/items/:id/replenishment', authMiddleware, async (req, res) => {
  try {
    const id = ownId(req.params.id);
    if (!id) throw notFound();
    res.json(await productDetail(req.user.id, id));
  } catch (err) { fail(res, err, 'computing the recommendation'); }
});

// ── Scenario (not saved) ─────────────────────────────────────────────────────
function parseScenario(b) {
  const out = {};
  const int = (field, min, max) => {
    if (b[field] === undefined || b[field] === null || b[field] === '') return;
    const n = Number(b[field]);
    if (!Number.isInteger(n) || n < min || n > max) throw P.bad(`${field} must be a whole number from ${min} to ${max}.`);
    out[field] = n;
  };
  int('review_period_days', 1, 28);
  int('safety_stock_units', 0, 1000000);
  int('lead_time_days', 0, 365);
  int('extra_delay_days', 1, 180);
  if (b.demand_change_pct !== undefined && b.demand_change_pct !== null && b.demand_change_pct !== '') {
    const n = Number(b.demand_change_pct);
    if (!Number.isFinite(n) || n < -100 || n > 1000) throw P.bad('demand_change_pct must be a number from -100 to 1000.');
    out.demand_change_pct = Math.round(n * 100) / 100;
  }
  if (b.include_uncertain_incoming !== undefined) out.include_uncertain_incoming = b.include_uncertain_incoming === true;
  if (!Object.keys(out).length) throw P.bad('Send review_period_days, safety_stock_units, lead_time_days, extra_delay_days, demand_change_pct and/or include_uncertain_incoming.');
  return out;
}

function applyScenario(inputs, s) {
  const next = JSON.parse(JSON.stringify(inputs));
  if (s.review_period_days !== undefined) Object.assign(next.policy, { review_period_days: s.review_period_days, review_period_source: 'scenario' });
  if (s.safety_stock_units !== undefined) Object.assign(next.policy, { safety_stock_units: s.safety_stock_units, safety_stock_source: 'scenario' });
  if (s.lead_time_days !== undefined && next.supplier.state === 'ok') next.supplier.lead_time_days = s.lead_time_days;
  // What-if supplier delay / demand change (labelled scenario, never saved). They need the calendar input.
  if (s.extra_delay_days !== undefined || s.demand_change_pct !== undefined) {
    if (!next.calendar) throw P.bad('Delay and demand-change scenarios need the store calendar (INVENTORY_CALENDAR_ENABLED).');
    const end = new Date(Date.parse(`${next.planning_date}T00:00:00Z`) + 400 * 86400000).toISOString().slice(0, 10);
    if (s.extra_delay_days !== undefined) {
      next.calendar.supplier_delays = [...next.calendar.supplier_delays, { id: 'scenario', version: 0, kind: 'supplier_delay',
        title: 'Scenario delay (not saved)', start_date: next.planning_date, end_date: end, scope: 'supplier', extra_delay_days: s.extra_delay_days }];
    }
    if (s.demand_change_pct !== undefined) {
      // Replaces your saved demand changes for this what-if, so two changes are never stacked silently.
      next.calendar.demand_changes = [{ id: 'scenario', version: 0, kind: 'demand_scenario', title: 'Scenario demand change (not saved)',
        start_date: next.planning_date, end_date: end, scope: 'all', demand_change_pct: s.demand_change_pct }];
    }
  }
  if (s.include_uncertain_incoming) {
    // Overdue and undated deliveries treated as arriving today (usable tomorrow, A2).
    next.incoming = next.incoming.map(l => (!l.expected_arrival || l.expected_arrival < next.planning_date
      ? { ...l, expected_arrival: next.planning_date, scenario_assumed: true } : l));
  }
  next.scenario = { ...s, saved: false };
  return next;
}

router.post('/inventory/items/:id/replenishment/scenario', authMiddleware, async (req, res) => {
  try {
    const id = ownId(req.params.id);
    if (!id) throw notFound();
    const scenario = parseScenario(req.body || {});
    const snap = await I.readSnapshot(pool, req.user.id, [id]);
    const entry = snap.products[0];
    if (!entry) throw notFound();
    const c = await compute(snap, entry, scenario);
    c.result.actionable = false;              // a scenario never creates a draft
    res.json({ product: entry.product, label: 'Scenario — not saved', saved: false, ...c.result });
  } catch (err) { fail(res, err, 'computing the scenario'); }
});

// ── Draft from a recommendation (decision Q9, amendment 4) ───────────────────
class Stale extends Error {}

router.post('/purchase-orders/from-recommendation', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const b = req.body || {};
    const recId = ownId(b.recommendation_id);
    if (!recId) throw P.bad('recommendation_id is required.');
    if (typeof b.inputs_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.inputs_sha256)) throw P.bad('inputs_sha256 is required.');
    const { rows } = await pool.query(
      `SELECT id, product_id, planning_date::text AS planning_date, engine_version, inputs_sha256, status, actionable,
              suggested_quantity, supplier_id, output
       FROM replenishment_recommendations WHERE id = $1 AND seller_id = $2`, [recId, sellerId]);
    const rec = rows[0];
    if (!rec) throw new InventoryError(404, { error: 'not_found', message: 'Recommendation not found.' });
    if (rec.inputs_sha256 !== b.inputs_sha256) {
      throw new InventoryError(409, { error: 'recommendation_mismatch', message: 'This recommendation was computed from different inputs than the page shows. Reload it.' });
    }
    const existing = await draftFor(pool, sellerId, rec.id);
    if (!existing && !(rec.actionable && rec.status === 'provisional' && rec.suggested_quantity > 0)) {
      throw new InventoryError(409, { error: 'not_actionable',
        message: 'Only a provisional recommendation with a quantity above zero can become a draft order.' });
    }
    // Warm the forecast cache outside the lock, so revalidation under the lock is a cache hit.
    if (!existing) {
      const warm = await I.readSnapshot(pool, sellerId, [rec.product_id]);
      if (warm.products[0]) await I.forecastInput(warm.products[0]);
    }

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      await lockSeller(client, sellerId);
      out = await (async () => {
        const prior = await draftFor(client, sellerId, rec.id);
        if (prior) return { id: prior.id, replayed: true };
        // Revalidate: the same facts, read now under the seller lock, must give the same fingerprint.
        const snap = await I.gather(client, sellerId, [rec.product_id]);
        const entry = snap.products[0];
        if (!entry) throw notFound();
        const c = await compute(snap, entry);
        if (c.sha !== rec.inputs_sha256) throw Object.assign(new Stale(), { snap, entry, c });
        const qty = rec.suggested_quantity;
        const lines = await P.validateLines(client, sellerId, rec.supplier_id, [{ product_id: rec.product_id, quantity: qty }]);
        const { rows: sup } = await client.query('SELECT default_currency FROM suppliers WHERE id = $1 AND seller_id = $2', [rec.supplier_id, sellerId]);
        const currency = c.result.supplier.currency || sup[0].default_currency;
        const location = await P.ensureDefaultLocation(client, sellerId);
        // One live order per recommendation; after a cancellation a new draft gets the next key.
        const { rows: earlier } = await client.query(
          'SELECT COUNT(*)::int AS n FROM purchase_orders WHERE seller_id = $1 AND source_recommendation_id = $2', [sellerId, rec.id]);
        const key = `recommendation-${rec.id}-${earlier[0].n + 1}`;
        const notes = `Draft from recommendation #${rec.id} (planning date ${rec.planning_date}, ${rec.engine_version}). `
          + 'Add the supplier\'s promised arrival date when you place it.';
        const content = P.sha({ supplier: rec.supplier_id, currency, expected: null, notes, lines: [[rec.product_id, qty]] });
        const { rows: ins } = await client.query(
          `INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, idempotency_key, content_sha256, notes, created_by,
             source_recommendation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $8) RETURNING id`,
          [sellerId, rec.supplier_id, location.id, currency, key, content, notes, rec.id]);
        await P.insertLines(client, sellerId, ins[0].id, lines);
        await P.addEvent(client, { sellerId, poId: ins[0].id, event: 'created', to: 'draft', actor: sellerId,
          detail: { lines: [{ product_id: rec.product_id, quantity: qty }], currency, expected_arrival: null,
            from_recommendation: { id: rec.id, inputs_sha256: rec.inputs_sha256, engine_version: rec.engine_version } } });
        return { id: ins[0].id, replayed: false };
      })();
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof Stale) {
        const id = await log(pool, err.snap, err.entry, err.c);
        return res.status(409).json({ error: 'recommendation_stale',
          message: 'Something this recommendation depends on has changed since it was shown. Review the recomputed result before creating a draft.',
          current: detail(err.entry, err.c, id, await draftFor(pool, sellerId, id)) });
      }
      if (err.code === '23505' && /one_per_recommendation|idempotency_key/.test(`${err.constraint} ${err.detail}`)) {
        const prior = await draftFor(pool, sellerId, rec.id);
        if (prior) out = { id: prior.id, replayed: true };
        else throw err;
      } else throw err;
    } finally {
      client.release();
    }
    if (!out && existing) out = { id: existing.id, replayed: true };
    const view = await P.orderView(pool, sellerId, out.id, (await I.readSnapshot(pool, sellerId, [])).planning_date);
    res.status(out.replayed ? 200 : 201).json({ purchase_order: view, replayed: out.replayed, recommendation_id: rec.id });
  } catch (err) { fail(res, err, 'creating the draft order'); }
});

module.exports = router;
