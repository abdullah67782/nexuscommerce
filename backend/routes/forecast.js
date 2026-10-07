const express = require('express');
const axios = require('axios');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { findOwnedProduct } = require('../lib/ownership');

const router = express.Router();
const finetuneRouter = express.Router();

const ML_SERVER = process.env.ML_SERVER_URL || 'http://localhost:8000';

async function callMLServer(method, endpoint, data = null, timeout = 30000) {
  try {
    const url = `${ML_SERVER}${endpoint}`;
    const config = { timeout };
    const response = method === 'GET'
      ? await axios.get(url, config)
      : await axios.post(url, data, config);
    return response.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error('ML server is not running. Start it with: python ml/main.py');
    }
    if (err.response) {
      // Preserve the original status + body for 422 insufficient_history passthrough
      const e = new Error(err.response.data?.detail || err.response.data?.message || 'ML server error');
      e.mlStatus = err.response.status;
      e.mlData = err.response.data;
      throw e;
    }
    throw new Error(`ML server request failed: ${err.message}`);
  }
}

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
       JOIN sales s ON s.product_id = f.product_id
                   AND s.sale_date = f.forecast_date
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
    res.json(result);
  } catch (err) {
    console.error('Finetune status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, finetuneRouter };
