const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { isManualTrainingEnabled, TRAINING_DISABLED } = require('../lib/training');

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
// Body: { import_id?: string, products: [{name, category, price}],
//         sales: [{product_name, quantity, sale_date, revenue}] }
//
// Import identity: every call is one logical import, recorded in data_uploads
// (source = 'store_connect') with a version, and every sale/product it creates
// points back to it (upload_id). The identity is the client's import_id, or a
// hash of the payload when none is sent. Retrying the same import — including
// concurrently — returns the original result instead of importing again.
// Reusing an import_id for different data is refused (409).
//
// Importing does NOT start model training; the response says so explicitly.
// ═══════════════════════════════════════════════════════════════════════════════

// A real calendar date (YYYY-MM-DD…) that is not in the future, matching the
// upload validator's rule. Rejects rolled-over dates such as 2026-02-30.
const isValidDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day && parsed <= new Date();
};

// JSON with object keys sorted, so the same payload always hashes the same.
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const FINE_TUNING_NOT_STARTED = {
  status: 'not_started',
  automatic: false,
  reason: 'Automatic fine-tuning is disabled.',
};

async function replayOf(db, userId, key, payloadHash) {
  const { rows } = await db.query(
    `SELECT du.id, du.payload_sha256, du.result_summary,
            COALESCE(uv.is_rolled_back, false) AS rolled_back
     FROM data_uploads du
     LEFT JOIN upload_versions uv ON uv.upload_id = du.id
     WHERE du.uploaded_by = $1 AND du.idempotency_key = $2`,
    [userId, key],
  );
  const prior = rows[0];
  if (!prior) return null;
  if (prior.payload_sha256 !== payloadHash) {
    return { status: 409, body: {
      error: 'import_id_conflict',
      message: 'This import_id was already used for different data. Use a new import_id for a new import.',
      import_record_id: prior.id,
    } };
  }
  return { status: 200, body: { ...prior.result_summary, replayed: true, rolled_back: prior.rolled_back } };
}

router.post('/connect', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { products = [], sales = [], import_id: importId } = req.body || {};

  if (!Array.isArray(sales) || !sales.length) {
    return res.status(400).json({ error: 'sales array is required and must not be empty.' });
  }
  if (!Array.isArray(products)) {
    return res.status(400).json({ error: 'products must be an array.' });
  }
  if (importId !== undefined && (typeof importId !== 'string' || !importId.trim() || importId.length > 200)) {
    return res.status(400).json({ error: 'import_id must be a non-empty string of at most 200 characters.' });
  }

  const payloadHash = crypto.createHash('sha256').update(stableStringify({ products, sales })).digest('hex');
  const key = importId ? `client:${importId}` : `payload:${payloadHash}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claim the import identity first. A concurrent retry with the same key
    // waits on the unique index here and then sees the committed original.
    const claim = await client.query(
      `INSERT INTO data_uploads
         (uploaded_by, file_format, total_records, clean_records, source, idempotency_key, payload_sha256)
       VALUES ($1, 'api', $2, 0, 'store_connect', $3, $4)
       ON CONFLICT (uploaded_by, idempotency_key) DO NOTHING
       RETURNING id`,
      [userId, sales.length, key, payloadHash],
    );
    if (!claim.rows.length) {
      // Reuse the connection we already hold: asking the pool for a second one
      // here deadlocks when the pool is saturated (e.g. a one-connection pool).
      await client.query('ROLLBACK');
      const replay = await replayOf(client, userId, key, payloadHash);
      if (!replay) throw new Error('Import identity conflict could not be resolved.');
      return res.status(replay.status).json(replay.body);
    }
    const importRecordId = claim.rows[0].id;

    // Reuse this seller's existing product by name; create it otherwise.
    // A Map, so names such as "constructor" or "__proto__" are plain keys.
    const productIds = new Map();
    let productsCreated = 0;
    const ensureProduct = async (name, category = null, price = null) => {
      if (productIds.has(name)) return productIds.get(name);
      const existing = await client.query(
        'SELECT id FROM products WHERE user_id = $1 AND name = $2 ORDER BY id LIMIT 1',
        [userId, name],
      );
      let id;
      if (existing.rows.length) {
        id = existing.rows[0].id;
      } else {
        const created = await client.query(
          `INSERT INTO products (user_id, name, category, current_price, upload_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [userId, name, category, price, importRecordId],
        );
        id = created.rows[0].id;
        productsCreated++;
      }
      productIds.set(name, id);
      return id;
    };

    for (const p of products) {
      if (p && typeof p.name === 'string' && p.name.trim()) {
        await ensureProduct(p.name.trim(), p.category || null, p.price ?? null);
      }
    }

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
      // The legacy (product, date, quantity, revenue) constraint still applies
      // until the line-identity migration replaces it.
      const result = await client.query(
        `INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, sale_date, quantity, revenue) DO NOTHING
         RETURNING id`,
        [productId, quantity, s.sale_date, s.revenue ?? null, importRecordId],
      );
      if (result.rows.length) imported++;
      else duplicates++;
    }

    const version = await client.query(
      `INSERT INTO upload_versions (seller_id, upload_id, version_number, rows_added, rows_skipped, rows_rejected)
       SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3, $4, $5
       FROM upload_versions WHERE seller_id = $1
       RETURNING version_number`,
      [userId, importRecordId, imported, duplicates, rejected],
    );

    const valid = sales.length - rejected;
    const summary = {
      status: 'imported',
      message: 'Store data imported. Model training was not started.',
      import_record_id: importRecordId,
      version_number: version.rows[0].version_number,
      records_received: sales.length,
      records_imported: imported,
      duplicates_skipped: duplicates,
      records_rejected: rejected,
      products_created: productsCreated,
      fine_tuning: FINE_TUNING_NOT_STARTED,
    };
    await client.query(
      `UPDATE data_uploads SET clean_records = $2, quality_score = $3, result_summary = $4 WHERE id = $1`,
      [importRecordId, valid, Number(((valid / sales.length) * 100).toFixed(2)), summary],
    );

    await client.query('COMMIT');
    res.json({ ...summary, replayed: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Store connect error:', err.message);
    res.status(500).json({ error: 'Error importing store data' });
  } finally {
    client.release();
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/store/finetune
// Disabled unless MANUAL_FINETUNE_ENABLED=true (see lib/training.js).
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/finetune', authMiddleware, async (req, res) => {
  if (!isManualTrainingEnabled()) {
    return res.status(403).json(TRAINING_DISABLED);
  }
  const userId = req.user.id;

  // Verify the user has enough (correctly attributed) sales data
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT sale_date) AS days FROM attributed_sales WHERE seller_id = $1`,
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
    res.json({ ...result, training_enabled: isManualTrainingEnabled() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
