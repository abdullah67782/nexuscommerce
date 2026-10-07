const express = require('express');
const axios = require('axios');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const ML_SERVER = process.env.ML_SERVER_URL || 'http://localhost:8000';

async function callML(method, endpoint, data = null) {
  const url = `${ML_SERVER}${endpoint}`;
  const cfg = { timeout: 300000 }; // 5 min — fine-tuning takes time
  try {
    const res = method === 'GET'
      ? await axios.get(url, cfg)
      : await axios.post(url, data, cfg);
    return res.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') throw new Error('ML server is not running.');
    throw new Error(err.response?.data?.detail || err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/store/connect
// Import store sales data (product + sales rows) for the logged-in seller.
// Body: { products: [{name, category, price}], sales: [{product_name, quantity, sale_date, revenue}] }
//
// Importing does NOT start model fine-tuning. Automatic fine-tuning is disabled
// until separate evidence shows it helps; the response says so explicitly.
// ═══════════════════════════════════════════════════════════════════════════════
// A real calendar date (YYYY-MM-DD…) that is not in the future, matching the
// upload validator's rule. Rejects rolled-over dates such as 2026-02-30.
const isValidDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day && parsed <= new Date();
};

router.post('/connect', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { products = [], sales = [] } = req.body || {};

  if (!Array.isArray(sales) || !sales.length) {
    return res.status(400).json({ error: 'sales array is required and must not be empty.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reuse this seller's existing product by name; create it otherwise.
    const productMap = {};
    let productsCreated = 0;
    const ensureProduct = async (name, category = null, price = null) => {
      if (productMap[name]) return productMap[name];
      const existing = await client.query(
        'SELECT id FROM products WHERE user_id = $1 AND name = $2 ORDER BY id LIMIT 1',
        [userId, name],
      );
      if (existing.rows.length) {
        productMap[name] = existing.rows[0].id;
      } else {
        const created = await client.query(
          `INSERT INTO products (user_id, name, category, current_price)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, name, category, price],
        );
        productMap[name] = created.rows[0].id;
        productsCreated++;
      }
      return productMap[name];
    };

    for (const p of products) {
      if (p && typeof p.name === 'string' && p.name.trim()) {
        await ensureProduct(p.name.trim(), p.category || null, p.price ?? null);
      }
    }

    // Insert sales rows; skip exact duplicates instead of failing the import.
    let imported = 0;
    let duplicates = 0;
    let rejected = 0;
    for (const s of sales) {
      const name = typeof s?.product_name === 'string' ? s.product_name.trim() : '';
      const quantity = Number(s?.quantity);
      if (!name || !Number.isFinite(quantity) || quantity <= 0 || !isValidDate(s?.sale_date)) {
        rejected++;
        continue;
      }
      const productId = await ensureProduct(name);
      const result = await client.query(
        `INSERT INTO sales (product_id, quantity, sale_date, revenue)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, sale_date, quantity, revenue) DO NOTHING
         RETURNING id`,
        [productId, quantity, s.sale_date, s.revenue ?? null],
      );
      if (result.rows.length) imported++;
      else duplicates++;
    }

    await client.query('COMMIT');

    res.json({
      status: 'imported',
      message: 'Store data imported. Model training was not started.',
      records_received: sales.length,
      records_imported: imported,
      duplicates_skipped: duplicates,
      records_rejected: rejected,
      products_created: productsCreated,
      fine_tuning: {
        status: 'not_started',
        automatic: false,
        reason: 'Automatic fine-tuning is disabled.',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Store connect error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/store/finetune
// Trigger fine-tuning using sales data already in the DB for this user.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/finetune', authMiddleware, async (req, res) => {
  const userId = req.user.id;

  // Verify the user has enough sales data
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT s.sale_date) AS days
     FROM sales s
     JOIN products p ON s.product_id = p.id
     WHERE p.user_id = $1`,
    [userId],
  );
  const days = parseInt(rows[0].days, 10);

  if (days < 30) {
    return res.status(400).json({
      error: `Not enough data. Need at least 30 days of sales, found ${days}.`,
      days_found: days,
    });
  }

  try {
    const result = await callML('POST', '/finetune', { seller_id: userId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/store/finetune/status
// Poll the status of the latest fine-tuning job for the logged-in user.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/finetune/status', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await callML('GET', `/finetune/status/${userId}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
