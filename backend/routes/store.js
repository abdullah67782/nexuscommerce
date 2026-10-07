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
// Import store sales data (CSV rows) and immediately trigger fine-tuning.
// Body: { products: [{name, category, price}], sales: [{product_name, quantity, sale_date, revenue}] }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/connect', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { products = [], sales = [] } = req.body;

  if (!sales.length) {
    return res.status(400).json({ error: 'sales array is required and must not be empty.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert products and build a name→id map
    const productMap = {};
    for (const p of products) {
      const result = await client.query(
        `INSERT INTO products (user_id, name, category, current_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [userId, p.name, p.category || null, p.price || null],
      );
      if (result.rows.length) {
        productMap[p.name] = result.rows[0].id;
      }
    }

    // Ensure there's at least a default product for this user
    let defaultProductId;
    {
      const r = await client.query(
        `SELECT id FROM products WHERE user_id = $1 ORDER BY id LIMIT 1`,
        [userId],
      );
      if (r.rows.length) {
        defaultProductId = r.rows[0].id;
      } else {
        const r2 = await client.query(
          `INSERT INTO products (user_id, name) VALUES ($1, 'Default') RETURNING id`,
          [userId],
        );
        defaultProductId = r2.rows[0].id;
      }
    }

    // Insert sales rows
    let inserted = 0;
    for (const s of sales) {
      const pid = productMap[s.product_name] ?? defaultProductId;
      await client.query(
        `INSERT INTO sales (product_id, quantity, sale_date, revenue)
         VALUES ($1, $2, $3, $4)`,
        [pid, s.quantity, s.sale_date, s.revenue || null],
      );
      inserted++;
    }

    await client.query('COMMIT');

    // Trigger fine-tuning in the ML server (non-blocking from client's perspective)
    let finetune;
    try {
      finetune = await callML('POST', '/finetune', {
        seller_id: userId,
        min_records: 30,
      });
    } catch (mlErr) {
      finetune = { message: `Fine-tuning could not start: ${mlErr.message}` };
    }

    res.json({
      message: 'Store connected and fine-tuning triggered.',
      records_imported: inserted,
      finetune,
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
