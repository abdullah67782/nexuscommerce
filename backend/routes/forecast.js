const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { findOwnedProduct } = require('../lib/ownership');
const { isManualTrainingEnabled, TRAINING_DISABLED } = require('../lib/training');
const { productHistory } = require('../lib/coverage');
const { todayIn, defaultTimezone } = require('../lib/imports');

const router = express.Router();
const finetuneRouter = express.Router();

// The ML client and the v2 forecast path live in lib/forecastService.js (shared with Stage 2).
const { callMLServer, forecastFromHistory, explainV2 } = require('../lib/forecastService');
const UE = require('../lib/upperEstimates');
const SF = require('../lib/stockoutFlags');
const CAL = require('../lib/calendar');

// ═══════════════════════════════════════════════════════════════════════════
// Forecast v2 — 7- and 28-day TOTALS for one product (switchable for review).
// Enabled only when FORECAST_V2_ENABLED=true; the existing daily forecast below
// is unchanged and separate. The backend resolves the product's usable history
// (lib/coverage.js: unknown days are never zero); the ML server's /v2/forecast
// chooses the tier and method and loads only the approved ml/models_v2 files.
// No daily breakdown, accuracy figure or confidence interval is returned.
// ═══════════════════════════════════════════════════════════════════════════
const isV2Enabled = () => process.env.FORECAST_V2_ENABLED === 'true';
const V2_TIERS = { insufficient: 'fewer than 28 days', average: '28 to 179 days', model: '180 days or more' };

router.get('/v2/config', authMiddleware, (req, res) => {
  res.json({ enabled: isV2Enabled(), horizons: [7, 28], tiers: V2_TIERS, history: 'confirmed days only' });
});

router.get('/v2/:productId', authMiddleware, async (req, res) => {
  if (!isV2Enabled()) {
    return res.status(404).json({ error: 'forecast_v2_disabled', message: 'Forecast v2 is switched off (FORECAST_V2_ENABLED).' });
  }
  const productId = Number(req.params.productId);
  const product = await findOwnedProduct(productId, req.user.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const history = await productHistory(pool, req.user.id, productId);
  const timezone = history.sources.find(s => s.timezone)?.timezone || defaultTimezone();
  const today = todayIn(timezone);
  if (!history.first_sale) {
    return res.json({ version: 2, product, status: 'no_sales', history: null, forecasts: [], pattern: null,
      notes: [{ type: 'tier', text: 'No sales are recorded for this product yet.' }], today, timezone });
  }
  let result;
  try {
    result = await forecastFromHistory(history);
  } catch (err) {
    return res.status(503).json({ error: 'forecast_v2_unavailable', message: err.message });
  }
  let flags = null;
  let events = [];
  try {
    flags = await SF.forProduct(pool, req.user.id, productId, history);
    events = await eventsInHorizon(req.user.id, product, result.forecasts || []);
  } catch (err) {
    console.error('Forecast notes error:', err.message);   // notes are context only; the forecast is still returned
  }
  res.json({
    version: 2,
    product,
    status: result.status,
    models_release: result.models_release || null,
    history: {
      ...result.history,
      first_sale: history.first_sale, last_record: history.last_record,
      confirmed_days: history.counts.confirmed, unconfirmed_days: history.counts.unconfirmed, missing_days: history.counts.missing,
      unconfirmed_periods: history.unconfirmed_periods, missing_periods: history.missing_periods, sources: history.sources,
    },
    pattern: result.pattern,
    forecasts: result.forecasts,
    notes: [...explainV2(history, result, today), ...(flags ? SF.notes(flags) : []), ...eventNotes(events)],
    stockout_flags: flags,
    events_in_horizon: events,
    today,
    timezone,
  });
});

// Events in the forecast period (Stage 3 proposal §5, label 'none'): no event effect passed its evaluation, so the
// forecast is unchanged and each event is listed with "effect unknown". Seller entries are listed with their own
// labels; they are applied in replenishment, never in the forecast.
async function eventsInHorizon(sellerId, product, forecasts) {
  const f28 = forecasts.find(f => f.horizon_days === 28) || forecasts[forecasts.length - 1];
  if (!f28) return [];
  const cal = await CAL.readAll(pool, sellerId);
  const days = Math.round((Date.parse(`${f28.end}T00:00:00Z`) - Date.parse(`${f28.start}T00:00:00Z`)) / 86400000) + 1;
  const mine = CAL.forProduct(cal, product, null, f28.start, days);
  const holidays = mine.holidays.map(h => ({ kind: 'holiday', name: h.name, start: h.start, end: h.end, status: h.status,
    label: 'none', effect_label: 'Effect unknown' }));
  const entries = [...mine.closures, ...mine.demand_changes, ...mine.promotions_without_change].map(e => ({ kind: e.kind, name: e.title,
    start: e.start_date, end: e.end_date, label: CAL.entryLabel(e), label_text: CAL.LABELS[CAL.entryLabel(e)],
    demand_change_pct: e.demand_change_pct }));
  return [...holidays, ...entries].sort((a, b) => a.start.localeCompare(b.start));
}
function eventNotes(events) {
  if (!events.length) return [];
  return [{ type: 'events', text: `In this period: ${events.map(e => `${e.name} (${e.start === e.end ? e.start : `${e.start} to ${e.end}`}; `
    + `${e.kind === 'holiday' ? 'effect unknown' : e.label_text.toLowerCase()})`).join(', ')}. `
    + 'The forecast does not include any event effect; changes you entered are applied in replenishment as your own assumptions.' }];
}

// ═══════════════════════════════════════════════════════════════════════════
// Upper demand estimates (upper-estimates-1, policy upper-estimates-policy-1).
// One-sided 80%/90% UPPER estimates beside the unchanged v2 forecast, only where the
// store, product and data conditions of the Stage 3 final evaluation hold (lib/upperEstimates.js
// and ml/v2/upper_estimates.py). Display-only: never stored, never used by replenishment.
//   GET /v2/:productId/upper-estimates
//   GET /upper-estimates/settings            the seller's answers and the store-level checks
//   PUT /upper-estimates/settings            { status: 'confirmed'|'withdrawn', acknowledge, version? }
//   PUT /upper-estimates/products/:productId { department, version? }
// ═══════════════════════════════════════════════════════════════════════════
const ueFail = (res, status, error, message) => res.status(status).json({ error, message });

router.get('/v2/:productId/upper-estimates', authMiddleware, async (req, res) => {
  if (!isV2Enabled()) {
    return res.status(404).json({ error: 'forecast_v2_disabled', message: 'Forecast v2 is switched off (FORECAST_V2_ENABLED).' });
  }
  try {
    const productId = Number(req.params.productId);
    const product = await findOwnedProduct(productId, req.user.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const store = await UE.storeChecks(pool, req.user.id, productId);
    const base = {
      policy_version: UE.POLICY_VERSION, kind: 'one-sided upper demand estimate',
      product: { ...product, department: store.type?.department ?? null, department_version: store.type?.version ?? null },
      checks: store.checks, departments: UE.DEPARTMENTS, limitations: [UE.LIMITATION], estimates: [], forecast: null,
    };
    if (store.reason) return res.json({ ...base, status: 'unavailable', reason: store.reason });
    const history = await productHistory(pool, req.user.id, productId);
    if (!history.usable) {
      return res.json({ ...base, status: 'unavailable',
        reason: { code: 'no_forecast', text: 'There is no forecast for this product yet, so there is no upper estimate.' } });
    }
    let r;
    try {
      r = await UE.fromHistory(history);
    } catch (err) {
      return res.json({ ...base, status: 'unavailable', reason: { code: 'service_unavailable', text: UE.REASONS.service_unavailable } });
    }
    res.json({
      ...base,
      version: r.version, ml_policy_version: r.policy_version, status: r.status, reason: r.reason,
      forecast: { status: r.forecast.status, models_release: r.forecast.models_release, pattern: r.forecast.pattern,
        history: { tier: r.forecast.history.tier, usable_days: r.forecast.history.usable_days }, forecasts: r.forecast.forecasts },
      estimates: r.estimates, limitations: r.limitations, benchmark: r.benchmark,
    });
  } catch (err) {
    console.error('Upper estimates error:', err.message);
    res.status(500).json({ error: 'server_error', message: 'Error loading upper estimates.' });
  }
});

router.get('/upper-estimates/settings', authMiddleware, async (req, res) => {
  try {
    const store = await UE.storeChecks(pool, req.user.id, null);
    res.json({
      enabled: UE.enabled(), policy_version: UE.POLICY_VERSION, profile: UE.PROFILE, profile_text: UE.PROFILE_TEXT,
      status: store.settings?.status ?? null, updated_at: store.settings?.updated_at ?? null, version: store.settings?.version ?? null,
      country: { code: store.country, confirmed: Boolean(store.country) }, checks: store.checks, reason: store.reason,
      departments: UE.DEPARTMENTS, limitation: UE.LIMITATION,
    });
  } catch (err) {
    console.error('Upper estimate settings error:', err.message);
    res.status(500).json({ error: 'server_error', message: 'Error loading settings.' });
  }
});

async function ueTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
class UeError extends Error { constructor(status, body) { super(body.message); this.status = status; this.body = body; } }
const versionOf = (raw) => (raw === undefined || raw === null || raw === '' ? null : Number(raw));

router.put('/upper-estimates/settings', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const { status, acknowledge } = req.body || {};
  if (!['confirmed', 'withdrawn'].includes(status)) return ueFail(res, 400, 'invalid_request', 'status must be "confirmed" or "withdrawn".');
  if (status === 'confirmed' && acknowledge !== true) {
    return ueFail(res, 400, 'acknowledgement_required', 'Confirm the store profile and that the estimates are not calibrated to your store (acknowledge: true).');
  }
  try {
    const row = await ueTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1, $2)', [74010008, sellerId]);
      if (status === 'confirmed') {
        const country = await UE.readCountry(db, sellerId);
        if (country !== 'US') {
          const code = !country ? 'country_not_confirmed' : country === 'PK' ? 'market_pakistan' : 'market_not_evaluated';
          throw new UeError(409, { error: code, message: UE.REASONS[code] });
        }
      }
      const cur = await UE.readSettings(db, sellerId);
      const want = versionOf(req.body.version);
      if (cur && want === null) throw new UeError(428, { error: 'version_required', message: 'Send the settings version you are changing.' });
      if (cur && want !== cur.version) throw new UeError(409, { error: 'version_conflict', message: 'The settings changed since you loaded them.', current_version: cur.version });
      const { rows } = await db.query(
        `INSERT INTO upper_estimate_settings (seller_id, profile, status, policy_version, updated_by)
         VALUES ($1, $2, $3, $4, $1)
         ON CONFLICT (seller_id) DO UPDATE SET profile = EXCLUDED.profile, status = EXCLUDED.status, policy_version = EXCLUDED.policy_version,
           updated_by = EXCLUDED.updated_by, updated_at = NOW(), version = upper_estimate_settings.version + 1
         RETURNING profile, status, policy_version, updated_at, version`, [sellerId, UE.PROFILE, status, UE.POLICY_VERSION]);
      await db.query(`INSERT INTO upper_estimate_events (seller_id, event, before, after, actor) VALUES ($1, $2, $3, $4, $1)`,
        [sellerId, status === 'confirmed' ? 'profile_confirmed' : 'profile_withdrawn', cur ? JSON.stringify(cur) : null,
          JSON.stringify({ ...rows[0], profile_text: status === 'confirmed' ? UE.PROFILE_TEXT : null })]);
      return rows[0];
    });
    res.json(row);
  } catch (err) {
    if (err instanceof UeError) return res.status(err.status).json(err.body);
    console.error('Upper estimate settings error:', err.message);
    res.status(500).json({ error: 'server_error', message: 'Error saving settings.' });
  }
});

router.put('/upper-estimates/products/:productId', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const productId = Number(req.params.productId);
  const department = req.body?.department;
  try {
    const product = await findOwnedProduct(productId, sellerId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!Object.hasOwn(UE.DEPARTMENTS, department)) {
      return ueFail(res, 400, 'invalid_request', `department must be one of: ${Object.keys(UE.DEPARTMENTS).join(', ')}.`);
    }
    const row = await ueTx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock($1, $2)', [74010008, sellerId]);
      const cur = await UE.readProductType(db, sellerId, productId);
      const want = versionOf(req.body.version);
      if (cur && want === null) throw new UeError(428, { error: 'version_required', message: 'Send the version you are changing.' });
      if (cur && want !== cur.version) throw new UeError(409, { error: 'version_conflict', message: 'This product changed since you loaded it.', current_version: cur.version });
      const { rows } = await db.query(
        `INSERT INTO upper_estimate_product_types (seller_id, product_id, department, updated_by) VALUES ($1, $2, $3, $1)
         ON CONFLICT (seller_id, product_id) DO UPDATE SET department = EXCLUDED.department, updated_by = EXCLUDED.updated_by,
           updated_at = NOW(), version = upper_estimate_product_types.version + 1
         RETURNING product_id, department, updated_at, version`, [sellerId, productId, department]);
      await db.query(`INSERT INTO upper_estimate_events (seller_id, product_id, event, before, after, actor) VALUES ($1, $2, 'product_type_set', $3, $4, $1)`,
        [sellerId, productId, cur ? JSON.stringify(cur) : null, JSON.stringify(rows[0])]);
      return rows[0];
    });
    res.json(row);
  } catch (err) {
    if (err instanceof UeError) return res.status(err.status).json(err.body);
    console.error('Upper estimate product type error:', err.message);
    res.status(500).json({ error: 'server_error', message: 'Error saving the product department.' });
  }
});

// ─── GET /api/forecast/metrics ─────────────────────────────────────────────
// Returns seller-specific model accuracy (no raw MAE/RMSE shown in UI)
router.get('/metrics', authMiddleware, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const result = await pool.query(
      `SELECT model_name, accuracy, evaluated_at
       FROM model_metrics
       WHERE seller_id = $1
       ORDER BY evaluated_at DESC
       LIMIT 1`,
      [sellerId]
    );

    if (!result.rows.length) {
      return res.json({ accuracy: null, model_name: null, last_trained: null });
    }

    const row = result.rows[0];
    res.json({
      accuracy: row.accuracy != null ? parseInt(row.accuracy) : null,
      model_name: row.model_name,
      last_trained: row.evaluated_at,
    });
  } catch (err) {
    console.error('Metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/forecast/:productId/accuracy ─────────────────────────────────
// Joins stored forecasts with actual sales to produce Forecast vs Actual data
router.get('/:productId/accuracy', authMiddleware, async (req, res) => {
  const productId = parseInt(req.params.productId);
  const sellerId = req.user.id;

  if (isNaN(productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  try {
    const product = await findOwnedProduct(productId, sellerId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const result = await pool.query(
      `SELECT
         f.forecast_date::text AS date,
         ROUND(f.predicted_demand)::int AS predicted,
         ROUND(SUM(s.quantity))::int AS actual
       FROM forecasts f
       JOIN attributed_sales s ON s.product_id = f.product_id
                   AND s.sale_date = f.forecast_date
                   AND s.seller_id = f.seller_id
       WHERE f.product_id = $1
         AND f.seller_id = $2
       GROUP BY f.forecast_date, f.predicted_demand
       ORDER BY f.forecast_date ASC`,
      [productId, sellerId]
    );

    if (!result.rows.length) {
      return res.json({ comparison: [], avg_accuracy: null, total_days: 0, model_used: null });
    }

    const comparison = result.rows
      .filter(r => r.actual > 0)
      .map(r => {
        const dayAcc = Math.max(0, Math.round(100 - (Math.abs(r.predicted - r.actual) / r.actual) * 100));
        return { date: r.date, predicted: r.predicted, actual: r.actual, accuracy: dayAcc };
      });

    const avgAccuracy = comparison.length
      ? Math.round(comparison.reduce((s, r) => s + r.accuracy, 0) / comparison.length)
      : null;

    res.json({
      comparison,
      avg_accuracy: avgAccuracy,
      total_days: comparison.length,
      model_used: 'xgboost',
    });
  } catch (err) {
    console.error('Accuracy comparison error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/forecast/:productId ──────────────────────────────────────────
router.get('/:productId', authMiddleware, async (req, res) => {
  const productId = parseInt(req.params.productId);
  const horizonDays = parseInt(req.query.period) || 7;
  const sellerId = req.user.id;

  if (isNaN(productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  try {
    // Only the product's owner may forecast it. Checked before calling the ML server.
    const product = await findOwnedProduct(productId, sellerId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const category = product.category || 'United_Kingdom';

    // Call ML server
    let result;
    try {
      result = await callMLServer('POST', '/predict/xgboost', {
        product_id: productId,
        seller_id: sellerId,
        horizon_days: horizonDays,
        category,
      });
    } catch (mlErr) {
      if (mlErr.mlStatus === 422 && mlErr.mlData?.error === 'insufficient_history') {
        return res.status(422).json({
          error: 'insufficient_history',
          message: 'This product needs at least 30 days of sales history to generate a forecast.',
          days_available: mlErr.mlData.days_available,
          days_needed: 30,
        });
      }
      throw mlErr;
    }

    // Real confidence bands using residual_std from backtest
    const residualStd = result.residual_std || null;
    const predictions = result.predictions.map(pred => {
      const demand = pred.quantity;
      let upper, lower;
      if (residualStd && residualStd > 0) {
        upper = demand + 1.96 * residualStd;
        lower = Math.max(0, demand - 1.96 * residualStd);
      } else {
        upper = demand * 1.196;
        lower = Math.max(0, demand * 0.804);
      }
      return { date: pred.date, demand, upper, lower };
    });

    // Store forecasts in DB (include seller_id)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const pred of predictions) {
        await client.query(
          `INSERT INTO forecasts
             (product_id, seller_id, predicted_demand, forecast_date, model_used,
              confidence_upper, confidence_lower)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [productId, sellerId, pred.demand, pred.date, 'xgboost', pred.upper, pred.lower]
        );
      }
      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      console.error('Error storing forecast:', dbErr.message);
    } finally {
      client.release();
    }

    // Summary stats
    const sorted = [...predictions].sort((a, b) => b.demand - a.demand);
    const summary = {
      avg: Math.round(predictions.reduce((s, p) => s + p.demand, 0) / predictions.length),
      peak_day: sorted[0].date,
      peak_val: Math.round(sorted[0].demand),
      low_day: sorted[sorted.length - 1].date,
      low_val: Math.round(sorted[sorted.length - 1].demand),
      total: Math.round(predictions.reduce((s, p) => s + p.demand, 0)),
    };

    res.json({
      product_id: productId,
      forecast: {
        points: predictions.map(p => ({
          date: p.date,
          day: new Date(p.date).toLocaleDateString('en-US', { weekday: 'short' }),
          demand: Math.round(p.demand),
          upper: Math.round(p.upper),
          lower: Math.round(p.lower),
        })),
        summary,
      },
      model_used: result.model_used,
      accuracy: result.accuracy != null ? parseInt(result.accuracy) : null,
      residual_std: residualStd,
      feature_importance: result.top_features || [],
    });
  } catch (err) {
    console.error('Forecast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FINE-TUNE ROUTER — mounted at /api/finetune in server.js
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/finetune
finetuneRouter.post('/', authMiddleware, async (req, res) => {
  if (!isManualTrainingEnabled()) {
    return res.status(403).json(TRAINING_DISABLED);
  }
  const sellerId = req.user.id;
  const category = req.body?.category || 'United_Kingdom';
  try {
    const result = await callMLServer('POST', '/finetune', { seller_id: sellerId, category }, 300000);
    res.json(result);
  } catch (err) {
    console.error('Finetune start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finetune/status
finetuneRouter.get('/status', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const result = await callMLServer('GET', `/finetune/status/${sellerId}`);
    res.json({ ...result, training_enabled: isManualTrainingEnabled() });
  } catch (err) {
    console.error('Finetune status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, finetuneRouter };
