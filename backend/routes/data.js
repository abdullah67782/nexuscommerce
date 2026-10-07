const express = require('express');
const multer = require('multer');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const {
  ImportConflict, sha256, lockSeller, businessDate, todayIn, ensureSource, claimImport,
  replayOf, insertSales, addVersion, recomputeFreshness, productResolver, freshnessScore,
} = require('../lib/imports');

const router = express.Router();

// ─── Multer Configuration ────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ];
  const allowedExts = ['.csv', '.json', '.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();
  (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext))
    ? cb(null, true)
    : cb(new Error('Only CSV, JSON, and Excel (.xlsx) files are supported'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── File Parsers ────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', (err) => reject(err));
  });
}

function parseJSON(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      resolve(Array.isArray(data) ? data : [data]);
    } catch (err) { reject(err); }
  });
}

function parseExcel(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      resolve(XLSX.utils.sheet_to_json(sheet));
    } catch (err) { reject(err); }
  });
}

async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.csv':  return parseCSV(filePath);
    case '.json': return parseJSON(filePath);
    case '.xlsx':
    case '.xls':  return parseExcel(filePath);
    default: throw new Error(`Unsupported file format: ${ext}`);
  }
}

// ─── Data Cleaning Utilities ─────────────────────────────────────────────────
// Every row keeps its original data-row number (1 = first row after the
// header) under the ROW symbol, through cleaning and validation, so anomalies
// and stored sales point back to the exact line of the file. Rows are never
// removed for being identical: genuine identical orders are kept, and replays
// of the same file are stopped by import identity instead (lib/imports.js).
const ROW = Symbol('sourceRow');

function normalizeKeys(rows) {
  return rows.map((row, i) => {
    const n = Object.create(null); // header names can never hit Object.prototype
    for (const key of Object.keys(row)) {
      const k = key.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      n[k] = row[key];
    }
    n[ROW] = i + 1;
    return n;
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median imputation (SRS FR-2). Every imputed value is reported, not silent.
function fillMissingWithMedian(rows, numericFields) {
  const imputed = [];
  for (const field of numericFields) {
    const values = rows.map((r) => parseFloat(r[field])).filter((v) => !isNaN(v));
    const med = median(values);
    for (const row of rows) {
      const val = row[field];
      if (val === null || val === undefined || val === '' || isNaN(parseFloat(val))) {
        imputed.push({ row: row[ROW], field, original: val, value: med });
        row[field] = med;
      } else {
        row[field] = parseFloat(val);
      }
    }
  }
  return imputed;
}

// IQR outlier removal (SRS FR-2). Removed rows are reported with their row number.
function detectOutliersIQR(rows, field) {
  const values = rows.map((r) => parseFloat(r[field])).filter((v) => !isNaN(v));
  if (values.length < 4) return { cleaned: rows, outliers: [] };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  const outliers = [];
  const cleaned = rows.filter((row) => {
    const val = parseFloat(row[field]);
    if (isNaN(val)) return true;
    if (val < lower || val > upper) { outliers.push({ row: row[ROW], field, value: val, row_data: row }); return false; }
    return true;
  });
  return { cleaned, outliers };
}

// ─── Data Cleaning Pipeline ──────────────────────────────────────────────────

function cleanData(rawRows) {
  let rows = normalizeKeys(rawRows);

  const numericFields = ['price', 'current_price', 'quantity', 'revenue', 'stock_level', 'reorder_threshold'];
  const presentNumeric = numericFields.filter((f) => rows.some((r) => r[f] !== undefined));
  const imputed = fillMissingWithMedian(rows, presentNumeric);

  const outliers = [];
  for (const field of ['quantity', 'revenue']) {
    if (rows.some((r) => r[field] !== undefined)) {
      const result = detectOutliersIQR(rows, field);
      rows = result.cleaned;
      outliers.push(...result.outliers);
    }
  }

  const report = {
    total_records: rawRows.length,
    clean_records: rows.length,
    quality_score: rawRows.length > 0 ? parseFloat(((rows.length / rawRows.length) * 100).toFixed(2)) : 0,
  };
  return { cleanedRows: rows, report, imputed, outliers };
}

// ─── Per-Row Validation ──────────────────────────────────────────────────────
// Sale dates are business-local days in the source timezone (lib/imports.js).

function validateRow(row, timezone) {
  const anomalies = [];
  const rowNumber   = row[ROW];
  const productName = row.product_name || row.name || null;
  const quantity    = parseFloat(row.quantity);
  const revenue     = parseFloat(row.revenue);
  const price       = parseFloat(row.current_price || row.price);
  const rawDate     = row.sale_date ?? row.date ?? null;
  const lineId      = row.line_id === undefined || row.line_id === null || row.line_id === ''
    ? null : String(row.line_id).trim();

  const push = (field, type, value, severity) =>
    anomalies.push({ product_name: productName || '(empty)', field, anomaly_type: type,
      original_value: String(value ?? ''), row_number: rowNumber, severity });

  if (!productName || String(productName).trim() === '') {
    push('product_name', 'missing_product_name', row.product_name || '', 'critical');
    return { valid: false, anomalies };
  }
  if (isNaN(quantity) || quantity <= 0) {
    push('quantity', quantity < 0 ? 'negative_value' : 'zero_quantity', row.quantity, 'critical');
    return { valid: false, anomalies };
  }
  if (!Number.isInteger(quantity)) {
    push('quantity', 'fractional_quantity', row.quantity, 'critical');
    return { valid: false, anomalies };
  }
  if (!isNaN(revenue) && revenue <= 0) {
    push('revenue', revenue < 0 ? 'negative_value' : 'zero_revenue', row.revenue, 'critical');
    return { valid: false, anomalies };
  }
  if (lineId !== null && lineId.length > 255) {
    push('line_id', 'invalid_line_id', lineId.slice(0, 40), 'critical');
    return { valid: false, anomalies };
  }

  let saleDate = null;
  if (rawDate !== null && rawDate !== '') {
    saleDate = businessDate(rawDate, timezone);
    if (!saleDate) {
      push('sale_date', 'invalid_date', rawDate, 'critical');
      return { valid: false, anomalies };
    }
    if (saleDate > todayIn(timezone)) {
      push('sale_date', 'future_date', rawDate, 'critical');
      return { valid: false, anomalies };
    }
    const tenYearsAgo = `${Number(todayIn(timezone).slice(0, 4)) - 10}${todayIn(timezone).slice(4)}`;
    if (saleDate < tenYearsAgo) push('sale_date', 'old_date', rawDate, 'warning'); // still imported
  }

  if (!isNaN(price) && price <= 0) {
    push('price', price < 0 ? 'negative_value' : 'zero_price', price, 'warning');
  }

  return {
    valid: true, anomalies, productName: String(productName).trim(), quantity,
    revenue: isNaN(revenue) ? null : revenue, price: isNaN(price) ? null : price,
    category: row.category || null, saleDate, lineId, rowNumber,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/data/upload ───────────────────────────────────────────────────
// Multipart: file, optional operation_id (identity of THIS upload action) and
// optional overlap_mode ('reject' default | 'append').
// No operation_id: identity is the file's content fingerprint, so re-sending the
// same file replays the original result. A new operation_id is a deliberate new
// import; overlaps with earlier rows of the same source are then refused unless
// overlap_mode = 'append'.
router.post('/data/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const sellerId = req.user.id;
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send a file with key "file".' });
  }
  const filePath = req.file.path;
  const cleanup = () => fs.unlink(filePath, () => {});

  const operationId = req.body?.operation_id;
  const overlapMode = req.body?.overlap_mode || 'reject';
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId.trim() || operationId.length > 200)) {
    cleanup();
    return res.status(400).json({ error: 'operation_id must be a non-empty string of at most 200 characters.' });
  }
  if (!['reject', 'append'].includes(overlapMode)) {
    cleanup();
    return res.status(400).json({ error: 'overlap_mode must be "reject" or "append".' });
  }

  let rawData;
  let contentSha;
  try {
    contentSha = sha256(fs.readFileSync(filePath));
    rawData = await parseFile(filePath);
  } catch (err) {
    cleanup();
    return res.status(400).json({ error: 'File could not be parsed', details: err.message });
  }
  if (!rawData || rawData.length === 0) {
    cleanup();
    return res.status(400).json({ error: 'File is empty or could not be parsed' });
  }

  const { cleanedRows, report, imputed, outliers } = cleanData(rawData);
  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const key = operationId ? `file-op:${operationId}` : `file-content:${contentSha}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, sellerId);
    const source = await ensureSource(client, sellerId, {
      kind: 'file', provider: 'file_upload', externalId: 'default', displayName: 'File uploads',
    });

    const uploadId = await claimImport(client, {
      sellerId, sourceId: source.id, source: 'file_upload', key, contentSha256: contentSha,
      fileFormat: ext, total: report.total_records, overlapMode,
    });
    if (!uploadId) {
      await client.query('ROLLBACK');
      const replay = await replayOf(client, sellerId, key, contentSha);
      return res.status(replay.status).json(replay.body);
    }

    const products = productResolver(client, sellerId, uploadId);
    const anomalies = [];
    const rows = [];
    let rejected = 0;
    let withoutDate = 0;

    for (const row of cleanedRows) {
      const v = validateRow(row, source.timezone);
      anomalies.push(...v.anomalies);
      if (!v.valid) { rejected++; continue; }

      const productId = await products.resolve(v.productName, {
        category: v.category, price: v.price, updateDetails: true,
      });
      if (v.saleDate) {
        rows.push({ productId, saleDate: v.saleDate, quantity: v.quantity, revenue: v.revenue,
          lineId: v.lineId, rowNumber: v.rowNumber });
      } else {
        withoutDate++;
      }

      // Inventory snapshot: the last row for a product wins (unchanged behaviour).
      const stockLevel = parseFloat(row.stock_level);
      if (!isNaN(stockLevel)) {
        const reorder = parseFloat(row.reorder_threshold) || 10;
        const inv = await client.query('SELECT id FROM inventory WHERE product_id = $1', [productId]);
        if (inv.rows.length) {
          await client.query(
            'UPDATE inventory SET stock_level = $1, reorder_threshold = $2, updated_at = NOW() WHERE product_id = $3',
            [stockLevel, reorder, productId]);
        } else {
          await client.query(
            'INSERT INTO inventory (product_id, stock_level, reorder_threshold) VALUES ($1, $2, $3)',
            [productId, stockLevel, reorder]);
        }
      }
    }

    for (const o of outliers) {
      anomalies.push({ product_name: o.row_data.product_name || o.row_data.name || '(empty)', field: o.field,
        anomaly_type: 'statistical_outlier', original_value: String(o.value), row_number: o.row, severity: 'warning' });
    }
    for (const m of imputed) {
      anomalies.push({ product_name: '(row)', field: m.field, anomaly_type: 'imputed_value',
        original_value: `${m.original ?? ''} -> ${m.value}`, row_number: m.row, severity: 'info' });
    }

    const result = await insertSales(client, { importId: uploadId, sourceId: source.id, rows, overlapMode });

    for (const a of anomalies) {
      await client.query(
        `INSERT INTO anomalies_detected
         (upload_id, seller_id, product_name, field, anomaly_type, original_value, row_number, severity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uploadId, sellerId, a.product_name, a.field, a.anomaly_type, a.original_value, a.row_number, a.severity]);
    }

    const versionNumber = await addVersion(client, {
      sellerId, importId: uploadId, added: result.inserted, skipped: result.alreadyImported, rejected,
    });
    const summary = {
      message:            'File uploaded and processed successfully',
      total_rows:         report.total_records,
      inserted:           result.inserted,
      skipped:            result.alreadyImported,
      rejected,
      identical_rows_kept: result.identicalRowsKept,
      rows_without_sale_date: withoutDate,
      outliers_removed:   outliers.length,
      values_imputed:     imputed.length,
      quality_score:      report.quality_score,
      version_number:     versionNumber,
      upload_id:          uploadId,
      anomaly_count:      anomalies.length,
      source_id:          source.id,
    };
    await client.query(
      'UPDATE data_uploads SET clean_records = $2, quality_score = $3, result_summary = $4 WHERE id = $1',
      [uploadId, report.clean_records, report.quality_score, summary]);
    await recomputeFreshness(client, sellerId);
    await client.query('COMMIT');
    res.status(200).json({ ...summary, replayed: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ImportConflict) return res.status(err.status).json(err.body);
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Error processing uploaded file', details: err.message });
  } finally {
    client.release();
    cleanup();
  }
});

// ─── GET /api/data/quality ───────────────────────────────────────────────────
router.get('/data/quality', authMiddleware, async (req, res) => {
  try {
    const query = `SELECT du.id, du.file_format, du.total_records, du.clean_records,
                du.quality_score, du.uploaded_at,
                COALESCE(uv.rows_skipped, 0)  AS duplicates,
                COALESCE(uv.rows_rejected, 0) AS rejected
         FROM data_uploads du
         LEFT JOIN upload_versions uv ON uv.upload_id = du.id
         WHERE du.uploaded_by = $1
         ORDER BY du.uploaded_at DESC LIMIT 1`;
    const params = [req.user.id];
    const result = await pool.query(query, params);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'No upload records found' });
    }

    const rec = result.rows[0];
    res.json({
      score:         parseFloat(rec.quality_score),
      quality_score: parseFloat(rec.quality_score), // backward-compat
      clean_records: rec.clean_records,
      total_records: rec.total_records,
      duplicates:    parseInt(rec.duplicates),
      outliers:      0,
      rejected:      parseInt(rec.rejected),
      last_upload:   rec.uploaded_at,
      uploaded_at:   rec.uploaded_at, // backward-compat
      file_format:   rec.file_format,
    });
  } catch (err) {
    console.error('Quality fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching quality report' });
  }
});

// ─── GET /api/data/versions ──────────────────────────────────────────────────
router.get('/data/versions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT uv.id, uv.upload_id, uv.version_number,
              uv.rows_added, uv.rows_skipped, uv.rows_rejected,
              uv.is_rolled_back, uv.rollback_at, uv.created_at,
              du.quality_score, du.file_format, du.total_records
       FROM upload_versions uv
       JOIN data_uploads du ON du.id = uv.upload_id
       WHERE uv.seller_id = $1
       ORDER BY uv.version_number DESC`,
      [req.user.id]
    );
    res.json({ versions: result.rows });
  } catch (err) {
    console.error('Versions fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching upload versions' });
  }
});

// ─── GET /api/data/anomalies ─────────────────────────────────────────────────
router.get('/data/anomalies', authMiddleware, async (req, res) => {
  try {
    const { severity, resolved } = req.query;
    let query = `SELECT * FROM anomalies_detected WHERE seller_id = $1`;
    const params = [req.user.id];
    let idx = 2;

    if (severity) { query += ` AND severity = $${idx++}`; params.push(severity); }
    if (resolved !== undefined) { query += ` AND resolved = $${idx++}`; params.push(resolved === 'true'); }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json({ anomalies: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('Anomalies fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching anomalies' });
  }
});

// ─── PATCH /api/data/anomalies/:id/resolve ───────────────────────────────────
router.patch('/data/anomalies/:id/resolve', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE anomalies_detected SET resolved = true
       WHERE id = $1 AND seller_id = $2 RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Anomaly not found' });
    }
    res.json({ status: 'resolved' });
  } catch (err) {
    console.error('Resolve anomaly error:', err.message);
    res.status(500).json({ error: 'Error resolving anomaly' });
  }
});

// ─── POST /api/data/rollback/:uploadId ──────────────────────────────────────
// Undo the seller's most recent committed import (file or store-connect).
// The import record keeps its identity and is marked rolled_back, so a delayed
// retry of the same operation is answered with the original result
// (rolled_back: true) and never restores the data.
router.post('/data/rollback/:uploadId', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const uploadId = parseInt(req.params.uploadId, 10);
  if (!Number.isInteger(uploadId)) return res.status(400).json({ error: 'Invalid upload id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, sellerId); // no import or rollback of this seller can interleave

    const verCheck = await client.query(
      `SELECT uv.id, uv.is_rolled_back FROM upload_versions uv
       WHERE uv.seller_id = $1 AND uv.upload_id = $2`,
      [sellerId, uploadId]);
    if (!verCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Upload not found or not yours' });
    }
    if (verCheck.rows[0].is_rolled_back) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This upload is already rolled back' });
    }
    const mostRecent = await client.query(
      `SELECT upload_id FROM upload_versions
       WHERE seller_id = $1 AND is_rolled_back = false
       ORDER BY version_number DESC LIMIT 1`,
      [sellerId]);
    if (!mostRecent.rows.length || mostRecent.rows[0].upload_id !== uploadId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only the most recent upload can be rolled back' });
    }

    const delSales = await client.query('DELETE FROM sales WHERE upload_id = $1 RETURNING id', [uploadId]);

    // Products created by this import that no longer have any sales. Their
    // inventory and forecast rows reference them, so remove those first.
    const orphanProducts = `SELECT id FROM products
       WHERE upload_id = $1 AND user_id = $2
         AND id NOT IN (SELECT DISTINCT product_id FROM sales WHERE product_id IS NOT NULL)`;
    await client.query(`DELETE FROM inventory WHERE product_id IN (${orphanProducts})`, [uploadId, sellerId]);
    await client.query(`DELETE FROM forecasts WHERE product_id IN (${orphanProducts})`, [uploadId, sellerId]);
    await client.query(`DELETE FROM products WHERE id IN (${orphanProducts})`, [uploadId, sellerId]);

    await client.query(
      `UPDATE upload_versions SET is_rolled_back = true, rollback_at = NOW()
       WHERE upload_id = $1 AND seller_id = $2`, [uploadId, sellerId]);
    await client.query(`UPDATE data_uploads SET status = 'rolled_back' WHERE id = $1`, [uploadId]);

    await recomputeFreshness(client, sellerId);
    await client.query('COMMIT');
    res.json({ status: 'success', rolled_back_rows: delSales.rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Rollback error:', err.message);
    res.status(500).json({ error: 'Error rolling back upload', details: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /api/data/freshness ─────────────────────────────────────────────────
router.get('/data/freshness', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM data_freshness WHERE seller_id = $1`, [req.user.id]
    );

    if (!result.rows.length) {
      return res.json({
        freshness_score:  0,
        last_upload_at:   null,
        last_sale_date:   null,
        total_records:    0,
        days_since_upload: null,
      });
    }

    const row = result.rows[0];
    // Recalculate freshness score live (in case time has passed)
    const freshScore = freshnessScore(row.last_upload_at);
    const daysSince  = row.last_upload_at
      ? Math.floor((Date.now() - new Date(row.last_upload_at).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    res.json({
      freshness_score:  freshScore,
      last_upload_at:   row.last_upload_at,
      last_sale_date:   row.last_sale_date,
      total_records:    row.total_records,
      days_since_upload: daysSince,
    });
  } catch (err) {
    console.error('Freshness fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching freshness data' });
  }
});

// ─── GET /api/products ───────────────────────────────────────────────────────
router.get('/products', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.category, p.current_price, p.created_at,
              COALESCE(i.stock_level, 0)        AS stock_level,
              COALESCE(i.reorder_threshold, 10) AS reorder_threshold
       FROM products p
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.user_id = $1
       ORDER BY p.id
       LIMIT 200`,
      [req.user.id]
    );
    res.json({ count: result.rows.length, products: result.rows });
  } catch (err) {
    console.error('Products fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching products' });
  }
});

// ─── GET /api/inventory/alerts ───────────────────────────────────────────────
router.get('/inventory/alerts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.name AS product_name, i.stock_level, i.reorder_threshold,
             CASE 
               WHEN i.stock_level = 0 THEN 'critical'
               WHEN i.stock_level <= i.reorder_threshold / 2 THEN 'high'
               ELSE 'medium'
             END as risk_level,
             'Restock immediately' as recommended_action
      FROM inventory i
      JOIN products p ON p.id = i.product_id
      WHERE i.stock_level <= i.reorder_threshold
        AND p.user_id = $1
      ORDER BY i.stock_level ASC
      LIMIT 10
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Inventory alerts error:', err.message);
    res.status(500).json({ error: 'Error fetching inventory alerts' });
  }
});

// ─── GET /api/sales ──────────────────────────────────────────────────────────
router.get('/sales', authMiddleware, async (req, res) => {
  try {
    const { product_id, start_date, end_date, product, range } = req.query;
    let query = `
      SELECT s.sale_date, SUM(s.quantity)::INT AS quantity, SUM(s.revenue)::FLOAT AS revenue
      FROM attributed_sales s
      WHERE s.seller_id = $1`;
    const params = [req.user.id];
    let i = 2;

    const prodFilter = product && product !== 'all' ? product : product_id;
    if (prodFilter && prodFilter !== 'all') {
      query += ` AND s.product_id = $${i++}`;
      params.push(prodFilter);
    }

    if (range && range !== 'all') {
      const days = parseInt(range);
      if (!isNaN(days)) {
        // Range ends at this seller's latest sale, not the latest sale of anyone.
        query += ` AND s.sale_date >= (SELECT MAX(s2.sale_date) FROM attributed_sales s2
                   WHERE s2.seller_id = $1) - INTERVAL '${days} days'`;
      }
    } else {
      if (start_date)  { query += ` AND s.sale_date >= $${i++}`; params.push(start_date); }
      if (end_date)    { query += ` AND s.sale_date <= $${i++}`; params.push(end_date); }
    }

    query += ' GROUP BY s.sale_date ORDER BY s.sale_date ASC';
    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, sales: result.rows });
  } catch (err) {
    console.error('Sales fetch error:', err.message);
    res.status(500).json({ error: 'Error fetching sales data' });
  }
});

// ─── GET /api/dashboard/stats ────────────────────────────────────────────────
router.get('/dashboard/stats', authMiddleware, async (req, res) => {
  try {
    const sellerId = req.user.id;
    // Excludes sales quarantined for conflicting provenance (see attributed_sales in initDb.js).
    const ownSales = 'FROM attributed_sales s WHERE s.seller_id = $1';

    const [prodsRes, salesRes, revRes, qualRes, dateRes, anomRes] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total_products FROM products WHERE user_id = $1', [sellerId]),
      pool.query(`SELECT COUNT(*) AS total_sales_records ${ownSales}`, [sellerId]),
      pool.query(`SELECT COALESCE(SUM(s.revenue), 0) AS total_revenue ${ownSales}`, [sellerId]),
      pool.query(
        'SELECT quality_score FROM data_uploads WHERE uploaded_by = $1 ORDER BY uploaded_at DESC LIMIT 1',
        [sellerId]
      ),
      pool.query(`SELECT MIN(s.sale_date) AS earliest_date, MAX(s.sale_date) AS latest_date ${ownSales}`, [sellerId]),
      pool.query(
        `SELECT COUNT(*) AS total FROM anomalies_detected
         WHERE seller_id = $1 AND severity = 'critical' AND resolved = false`,
        [sellerId]
      ),
    ]);

    res.json({
      total_products:       parseInt(prodsRes.rows[0].total_products),
      total_sales_records:  parseInt(salesRes.rows[0].total_sales_records),
      total_revenue:        parseFloat(revRes.rows[0].total_revenue),
      latest_quality_score: qualRes.rows.length ? parseFloat(qualRes.rows[0].quality_score) : null,
      critical_anomalies:   parseInt(anomRes.rows[0].total),
      date_range: {
        start: dateRes.rows[0].earliest_date,
        end:   dateRes.rows[0].latest_date,
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: 'Error fetching dashboard stats' });
  }
});

module.exports = router;
