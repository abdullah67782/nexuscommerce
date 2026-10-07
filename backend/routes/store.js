const express = require('express');
const axios = require('axios');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { isManualTrainingEnabled, TRAINING_DISABLED } = require('../lib/training');
const {
  ImportConflict, sha256, stableStringify, lockSeller, businessDate, todayIn, isValidTimezone,
  ensureSource, claimImport, replayOf, insertSales, addVersion, recomputeFreshness, productResolver,
} = require('../lib/imports');
const { CoverageError, parseCoverage, checkCoverage, recordCoverage } = require('../lib/coverage');

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
// Import sales from a connected store for the logged-in seller.
// Body: {
//   import_id?: string,                       identity of this import operation
//   connection?: { provider, external_store_id, display_name?, timezone? },
//   overlap_mode?: 'reject' | 'append',
//   products: [{ name, category?, price? }],
//   sales: [{ product_name, quantity, sale_date, revenue?, line_id? }],
//   coverage?: { start, end, scope: 'all_products' | 'listed_products', confirmed: true }
// }
// coverage confirms that this delivery contains ALL sales of the connection for
// those business days (all products, or the products named in this payload).
// With confirmed coverage, an empty sales array is a valid "nothing sold" export.
// Identity, line handling and overlap rules: lib/imports.js. Without import_id
// the identity is the payload fingerprint, so an identical retry is replayed.
// A rolled-back import keeps its identity: re-importing needs a new import_id.
// Importing never starts model training.
// ═══════════════════════════════════════════════════════════════════════════════
const FINE_TUNING_NOT_STARTED = {
  status: 'not_started',
  automatic: false,
  reason: 'Automatic fine-tuning is disabled.',
};

const optionalString = (v, max) => v === undefined || (typeof v === 'string' && v.trim() !== '' && v.length <= max);

router.post('/connect', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { products = [], sales = [], import_id: importId, connection, overlap_mode: overlapMode = 'reject',
    coverage: coverageInput } = req.body || {};

  if (!Array.isArray(sales) || (!sales.length && !coverageInput)) {
    return res.status(400).json({ error: 'sales array is required and must not be empty (unless a confirmed coverage period shows nothing was sold).' });
  }
  if (coverageInput !== undefined && (typeof coverageInput !== 'object' || coverageInput === null || Array.isArray(coverageInput))) {
    return res.status(400).json({ error: 'coverage must be an object { start, end, scope, confirmed }.' });
  }
  if (!Array.isArray(products)) {
    return res.status(400).json({ error: 'products must be an array.' });
  }
  if (!optionalString(importId, 200)) {
    return res.status(400).json({ error: 'import_id must be a non-empty string of at most 200 characters.' });
  }
  if (!['reject', 'append'].includes(overlapMode)) {
    return res.status(400).json({ error: 'overlap_mode must be "reject" or "append".' });
  }
  if (connection !== undefined && (typeof connection !== 'object' || connection === null
      || !optionalString(connection.provider, 50) || !optionalString(connection.external_store_id, 255)
      || !optionalString(connection.display_name, 255)
      || (connection.timezone !== undefined && !isValidTimezone(connection.timezone)))) {
    return res.status(400).json({ error: 'connection must have provider (≤50), external_store_id (≤255), optional display_name and a valid IANA timezone.' });
  }

  // Fingerprint of what was sent. Payloads without a connection hash exactly as
  // before migration 002, so retries of earlier imports are still recognised.
  const fingerprintInput = connection ? { products, sales, connection } : { products, sales };
  if (coverageInput) fingerprintInput.coverage = coverageInput;
  const contentSha = sha256(stableStringify(fingerprintInput));
  const key = importId ? `client:${importId}` : `payload:${contentSha}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, userId);
    const source = await ensureSource(client, userId, {
      kind: 'api',
      provider: connection?.provider || 'manual_api',
      externalId: connection?.external_store_id || 'default',
      displayName: connection?.display_name || 'Store connection',
      timezone: connection?.timezone || null,
    });

    const coverage = parseCoverage(coverageInput ?? null, source.timezone);
    const importRecordId = await claimImport(client, {
      sellerId: userId, sourceId: source.id, source: 'store_connect', key, contentSha256: contentSha,
      fileFormat: 'api', total: sales.length, overlapMode,
    });
    if (!importRecordId) {
      // Reuse the connection we already hold (a second one may not be available).
      await client.query('ROLLBACK');
      const replay = await replayOf(client, userId, key, contentSha);
      if (replay?.body?.error === 'operation_id_conflict') replay.body.error = 'import_id_conflict';
      return res.status(replay.status).json(replay.body);
    }

    const resolver = productResolver(client, userId, importRecordId);
    const named = new Set();
    for (const p of products) {
      if (p && typeof p.name === 'string' && p.name.trim()) {
        named.add(await resolver.resolve(p.name.trim(), { category: p.category || null, price: p.price ?? null }));
      }
    }

    const today = todayIn(source.timezone);
    const rows = [];
    let rejected = 0;
    for (const [i, s] of sales.entries()) {
      const name = typeof s?.product_name === 'string' ? s.product_name.trim() : '';
      const quantity = Number(s?.quantity);
      const saleDate = businessDate(s?.sale_date, source.timezone);
      const revenue = s?.revenue === undefined || s?.revenue === null ? null : Number(s.revenue);
      const lineId = s?.line_id === undefined || s?.line_id === null ? null : String(s.line_id).trim();
      if (!name || !Number.isInteger(quantity) || quantity <= 0 || !saleDate || saleDate > today
          || (revenue !== null && !(Number.isFinite(revenue) && revenue > 0))
          || (lineId !== null && (!lineId || lineId.length > 255))) {
        rejected++;
        continue;
      }
      const productId = await resolver.resolve(name);
      named.add(productId);
      rows.push({ productId, saleDate, quantity, revenue, lineId, rowNumber: i + 1 });
    }

    const listed = [...named];
    if (coverage) {
      if (rejected) {
        throw new CoverageError(400, { error: 'coverage_with_rejected_rows',
          message: `${rejected} sale(s) were invalid, so this delivery cannot be confirmed as complete. Nothing was imported.` });
      }
      if (coverage.scope === 'listed_products' && !listed.length) {
        throw new CoverageError(400, { error: 'invalid_coverage',
          message: 'listed_products coverage needs at least one product in products or sales.' });
      }
      await checkCoverage(client, { sourceId: source.id, importId: importRecordId, coverage, rows, productIds: listed });
    }
    const result = await insertSales(client, { importId: importRecordId, sourceId: source.id, rows, overlapMode });
    const coverageSummary = coverage
      ? await recordCoverage(client, { sellerId: userId, sourceId: source.id, importId: importRecordId, coverage,
          productIds: listed, evidence: 'connector_full_export' })
      : null;
    const versionNumber = await addVersion(client, {
      sellerId: userId, importId: importRecordId, added: result.inserted, skipped: result.alreadyImported, rejected,
    });

    const valid = sales.length - rejected;
    const summary = {
      status: 'imported',
      message: 'Store data imported. Model training was not started.',
      import_record_id: importRecordId,
      version_number: versionNumber,
      source_id: source.id,
      records_received: sales.length,
      records_imported: result.inserted,
      duplicates_skipped: result.alreadyImported,
      identical_rows_kept: result.identicalRowsKept,
      records_rejected: rejected,
      products_created: resolver.created(),
      coverage: coverageSummary,
      fine_tuning: FINE_TUNING_NOT_STARTED,
    };
    await client.query(
      'UPDATE data_uploads SET clean_records = $2, quality_score = $3, result_summary = $4 WHERE id = $1',
      [importRecordId, valid, sales.length ? Number(((valid / sales.length) * 100).toFixed(2)) : 100, summary]);
    await recomputeFreshness(client, userId);
    await client.query('COMMIT');
    res.json({ ...summary, replayed: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ImportConflict || err instanceof CoverageError) return res.status(err.status).json(err.body);
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
