const express = require('express');
const multer = require('multer');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');

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

function normalizeKeys(rows) {
  return rows.map((row) => {
    const n = Object.create(null); // header names can never hit Object.prototype
    for (const key of Object.keys(row)) {
      const k = key.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      n[k] = row[key];
    }
    return n;
  });
}

function removeDuplicates(rows) {
  const seen = new Set();
  let duplicatesRemoved = 0;
  const unique = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) { duplicatesRemoved++; return false; }
    seen.add(key); return true;
  });
  return { data: unique, duplicatesRemoved };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fillMissingWithMedian(rows, numericFields) {
  let missingCount = 0;
  for (const field of numericFields) {
    const values = rows.map((r) => parseFloat(r[field])).filter((v) => !isNaN(v));
    const med = median(values);
    for (const row of rows) {
      const val = row[field];
      if (val === null || val === undefined || val === '' || isNaN(parseFloat(val))) {
        row[field] = med; missingCount++;
      } else {
        row[field] = parseFloat(val);
      }
    }
  }
  return missingCount;
}

function isValidDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

function detectOutliersIQR(rows, field) {
  const values = rows.map((r) => parseFloat(r[field])).filter((v) => !isNaN(v));
  if (values.length < 4) return { cleaned: rows, outliersDetected: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  let outliersDetected = 0;
  const cleaned = rows.filter((row) => {
    const val = parseFloat(row[field]);
    if (isNaN(val)) return true;
    if (val < lower || val > upper) { outliersDetected++; return false; }
    return true;
  });
  return { cleaned, outliersDetected };
}

// ─── Data Cleaning Pipeline ──────────────────────────────────────────────────

function cleanData(rawRows) {
  const report = {
    total_records: rawRows.length,
    clean_records: 0,
    duplicates_removed: 0,
    missing_values_handled: 0,
    outliers_detected: 0,
    quality_score: 0,
    before_sample: rawRows.slice(0, 3),
    after_sample: [],
  };

  let rows = normalizeKeys(rawRows);

  const dedupResult = removeDuplicates(rows);
  rows = dedupResult.data;
  report.duplicates_removed = dedupResult.duplicatesRemoved;

  const numericFields = ['price', 'current_price', 'quantity', 'revenue', 'stock_level', 'reorder_threshold'];
  const presentNumeric = numericFields.filter((f) => rows.some((r) => r[f] !== undefined));
  report.missing_values_handled = fillMissingWithMedian(rows, presentNumeric);

  for (const field of ['quantity', 'revenue']) {
    if (rows.some((r) => r[field] !== undefined)) {
      const result = detectOutliersIQR(rows, field);
      rows = result.cleaned;
      report.outliers_detected += result.outliersDetected;
    }
  }

  report.clean_records = rows.length;
  report.after_sample = rows.slice(0, 3);
  report.quality_score = report.total_records > 0
    ? parseFloat(((report.clean_records / report.total_records) * 100).toFixed(2))
    : 0;

  return { cleanedRows: rows, report };
}

// ─── Freshness Score ─────────────────────────────────────────────────────────

function calculateFreshnessScore(lastUploadAt) {
  if (!lastUploadAt) return 0;
  const days = (Date.now() - new Date(lastUploadAt).getTime()) / (1000 * 60 * 60 * 24);
  if (days < 1)   return 100;
  if (days <= 2)  return 80;
  if (days <= 7)  return 60;
  if (days <= 14) return 40;
  if (days <= 28) return 20;
  return 0;
}

// ─── Per-Row Validation ──────────────────────────────────────────────────────

function validateRow(row, rowIdx, uploadId, sellerId) {
  const anomalies = [];
  const productName = row.product_name || row.name || null;
  const quantity    = parseFloat(row.quantity);
  const revenue     = parseFloat(row.revenue);
  const price       = parseFloat(row.current_price || row.price);
  const saleDate    = row.sale_date || row.date || null;
  const now         = new Date();
  const tenYearsAgo = new Date(now.getFullYear() - 10, now.getMonth(), now.getDate());

  const push = (field, type, value, severity) =>
    anomalies.push({ upload_id: uploadId, seller_id: sellerId, product_name: productName || '(empty)',
      field, anomaly_type: type, original_value: String(value ?? ''), row_number: rowIdx + 1, severity });

  // Product name required
  if (!productName || String(productName).trim() === '') {
    push('product_name', 'missing_product_name', row.product_name || '', 'critical');
    return { valid: false, anomalies };
  }

  // Quantity must be > 0
  if (isNaN(quantity) || quantity <= 0) {
    push('quantity', quantity < 0 ? 'negative_value' : 'zero_quantity', row.quantity, 'critical');
    return { valid: false, anomalies };
  }

  // Revenue must be > 0 if present
  if (!isNaN(revenue) && revenue !== null && revenue <= 0) {
    push('revenue', revenue < 0 ? 'negative_value' : 'zero_revenue', row.revenue, 'critical');
    return { valid: false, anomalies };
  }

  // Sale date validation
  if (saleDate) {
    if (!isValidDate(saleDate)) {
      push('sale_date', 'invalid_date', saleDate, 'critical');
      return { valid: false, anomalies };
    }
    const dateObj = new Date(saleDate);
    if (dateObj > now) {
      push('sale_date', 'future_date', saleDate, 'critical');
      return { valid: false, anomalies };
    }
    if (dateObj < tenYearsAgo) {
      push('sale_date', 'old_date', saleDate, 'warning');
      // warning only — still insert
    }
  }

  // Price warning (not a rejection)
  if (!isNaN(price) && price <= 0) {
    push('price', price < 0 ? 'negative_value' : 'zero_price', price, 'warning');
  }

  return { valid: true, anomalies };
}

// ─── Database Storage (v2 — dedup + seller-aware) ───────────────────────────

async function storeDataV2(cleanedRows, sellerId, uploadId) {
  const client = await pool.connect();
  let inserted  = 0;
  let skipped   = 0;
  let rejected  = 0;
  const allAnomalies = [];

  try {
    await client.query('BEGIN');

    for (let idx = 0; idx < cleanedRows.length; idx++) {
      const row = cleanedRows[idx];

      // Per-row validation
      const { valid, anomalies } = validateRow(row, idx, uploadId, sellerId);
      allAnomalies.push(...anomalies);
      if (!valid) { rejected++; continue; }

      const productName = row.product_name || row.name;
      const category    = row.category || null;
      const price       = parseFloat(row.current_price || row.price) || null;
      const quantity    = parseFloat(row.quantity);
      const saleDate    = row.sale_date || row.date || null;
      const revenue     = parseFloat(row.revenue) || null;

      // Upsert product
      let productId;
      // Scoped to this seller: another seller's product with the same name
      // (or an ownerless product) must never receive these sales.
      const existProd = await client.query(
        `SELECT id FROM products WHERE name = $1 AND user_id = $2`,
        [productName, sellerId]
      );

      if (existProd.rows.length > 0) {
        productId = existProd.rows[0].id;
        if (price !== null || category !== null) {
          await client.query(
            `UPDATE products SET current_price = COALESCE($1, current_price),
             category = COALESCE($2, category) WHERE id = $3`,
            [price, category, productId]
          );
        }
      } else {
        const ins = await client.query(
          `INSERT INTO products (name, category, current_price, user_id, upload_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [productName, category, price, sellerId, uploadId]
        );
        productId = ins.rows[0].id;
      }

      // Insert sale with dedup (ON CONFLICT … DO NOTHING)
      if (!isNaN(quantity) && saleDate && isValidDate(saleDate)) {
        const saleResult = await client.query(
          `INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (product_id, sale_date, quantity, revenue) DO NOTHING
           RETURNING id`,
          [productId, quantity, new Date(saleDate), revenue, uploadId]
        );

        if (saleResult.rows.length > 0) {
          inserted++;
        } else {
          skipped++;
          allAnomalies.push({
            upload_id: uploadId, seller_id: sellerId, product_name: productName,
            field: 'transaction', anomaly_type: 'duplicate_transaction',
            original_value: `date=${saleDate}, qty=${quantity}, rev=${revenue}`,
            row_number: idx + 1, severity: 'info',
          });
        }
      }

      // Upsert inventory
      const stockLevel = parseFloat(row.stock_level);
      if (!isNaN(stockLevel)) {
        const existInv = await client.query(
          `SELECT id FROM inventory WHERE product_id = $1`, [productId]
        );
        const reorder = parseFloat(row.reorder_threshold) || 10;
        if (existInv.rows.length > 0) {
          await client.query(
            `UPDATE inventory SET stock_level = $1, reorder_threshold = $2, updated_at = NOW()
             WHERE product_id = $3`,
            [stockLevel, reorder, productId]
          );
        } else {
          await client.query(
            `INSERT INTO inventory (product_id, stock_level, reorder_threshold) VALUES ($1, $2, $3)`,
            [productId, stockLevel, reorder]
          );
        }
      }
    }

    // Bulk-insert anomalies
    for (const a of allAnomalies) {
      await client.query(
        `INSERT INTO anomalies_detected
         (upload_id, seller_id, product_name, field, anomaly_type, original_value, row_number, severity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.upload_id, a.seller_id, a.product_name, a.field,
         a.anomaly_type, a.original_value, a.row_number, a.severity]
      );
    }

    await client.query('COMMIT');
    return { inserted, skipped, rejected, anomalyCount: allAnomalies.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Freshness Upsert ────────────────────────────────────────────────────────

async function updateFreshness(sellerId, insertedCount) {
  // Find the latest sale date for this seller's products
  const lastSaleRes = await pool.query(
    `SELECT MAX(sale_date) AS last_sale_date FROM attributed_sales WHERE seller_id = $1`,
    [sellerId]
  );

  // Total records for this seller
  const totalRes = await pool.query(
    `SELECT COUNT(*) AS total FROM attributed_sales WHERE seller_id = $1`,
    [sellerId]
  );

  const lastSaleDate   = lastSaleRes.rows[0]?.last_sale_date || null;
  const totalRecords   = parseInt(totalRes.rows[0]?.total || 0);
  const freshnessScore = calculateFreshnessScore(new Date());

  await pool.query(
    `INSERT INTO data_freshness (seller_id, last_upload_at, last_sale_date, total_records, freshness_score)
     VALUES ($1, NOW(), $2, $3, $4)
     ON CONFLICT (seller_id) DO UPDATE SET
       last_upload_at  = NOW(),
       last_sale_date  = EXCLUDED.last_sale_date,
       total_records   = EXCLUDED.total_records,
       freshness_score = EXCLUDED.freshness_score,
       updated_at      = NOW()`,
    [sellerId, lastSaleDate, totalRecords, freshnessScore]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/data/upload ───────────────────────────────────────────────────
router.post('/data/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const sellerId = req.user?.id || null;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send a file with key "file".' });
  }

  const filePath = req.file.path;
  const ext      = path.extname(req.file.originalname).toLowerCase();

  try {
    // 1. Parse
    const rawData = await parseFile(filePath);
    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ error: 'File is empty or could not be parsed' });
    }

    // 2. In-memory cleaning (normalize, fill missing, basic outlier removal)
    const { cleanedRows, report } = cleanData(rawData);

    // 3. Create upload record first to get upload_id
    const uploadRec = await pool.query(
      `INSERT INTO data_uploads (uploaded_by, file_format, total_records, clean_records, quality_score)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sellerId, ext.replace('.', ''), report.total_records, report.clean_records, report.quality_score]
    );
    const uploadId = uploadRec.rows[0].id;

    // 4. Store with per-row validation + dedup
    const { inserted, skipped, rejected, anomalyCount } = await storeDataV2(cleanedRows, sellerId, uploadId);

    // 5. Get next version number for this seller
    const verRes = await pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver
       FROM upload_versions WHERE seller_id = $1`,
      [sellerId]
    );
    const versionNumber = verRes.rows[0].next_ver;

    await pool.query(
      `INSERT INTO upload_versions
         (seller_id, upload_id, version_number, rows_added, rows_skipped, rows_rejected)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sellerId, uploadId, versionNumber, inserted, skipped, rejected]
    );

    // 6. Update data_freshness
    if (sellerId) await updateFreshness(sellerId, inserted);

    // 7. Clean up temp file
    fs.unlink(filePath, () => {});

    res.status(200).json({
      message:        'File uploaded and processed successfully',
      total_rows:     report.total_records,
      inserted,
      skipped,
      rejected,
      quality_score:  report.quality_score,
      version_number: versionNumber,
      upload_id:      uploadId,
      anomaly_count:  anomalyCount,
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Error processing uploaded file', details: err.message });
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
router.post('/data/rollback/:uploadId', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const uploadId = parseInt(req.params.uploadId);

  try {
    // Verify this upload belongs to this seller and is the most recent active one
    const verCheck = await pool.query(
      `SELECT uv.id, uv.rows_added, uv.is_rolled_back
       FROM upload_versions uv
       WHERE uv.seller_id = $1 AND uv.upload_id = $2`,
      [sellerId, uploadId]
    );

    if (!verCheck.rows.length) {
      return res.status(404).json({ error: 'Upload not found or not yours' });
    }
    if (verCheck.rows[0].is_rolled_back) {
      return res.status(400).json({ error: 'This upload is already rolled back' });
    }

    // Ensure it's the most recent non-rolled-back upload
    const mostRecent = await pool.query(
      `SELECT upload_id FROM upload_versions
       WHERE seller_id = $1 AND is_rolled_back = false
       ORDER BY version_number DESC LIMIT 1`,
      [sellerId]
    );
    if (!mostRecent.rows.length || mostRecent.rows[0].upload_id !== uploadId) {
      return res.status(400).json({ error: 'Only the most recent upload can be rolled back' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete sales tied to this upload
      const delSales = await client.query(
        `DELETE FROM sales WHERE upload_id = $1 RETURNING id`, [uploadId]
      );

      // Products created by this upload that no longer have any sales. Their
      // inventory and forecast rows reference them, so remove those first —
      // otherwise the foreign keys make the whole rollback fail.
      const orphanProducts = `SELECT id FROM products
         WHERE upload_id = $1 AND user_id = $2
           AND id NOT IN (SELECT DISTINCT product_id FROM sales WHERE product_id IS NOT NULL)`;
      await client.query(`DELETE FROM inventory WHERE product_id IN (${orphanProducts})`, [uploadId, sellerId]);
      await client.query(`DELETE FROM forecasts WHERE product_id IN (${orphanProducts})`, [uploadId, sellerId]);
      await client.query(`DELETE FROM products WHERE id IN (${orphanProducts})`, [uploadId, sellerId]);

      // Mark version as rolled back
      await client.query(
        `UPDATE upload_versions
         SET is_rolled_back = true, rollback_at = NOW()
         WHERE upload_id = $1 AND seller_id = $2`,
        [uploadId, sellerId]
      );

      await client.query('COMMIT');

      // Recalculate freshness
      await updateFreshness(sellerId, 0);

      res.json({
        status:            'success',
        rolled_back_rows:  delSales.rows.length,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Rollback error:', err.message);
    res.status(500).json({ error: 'Error rolling back upload', details: err.message });
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
    const freshScore = calculateFreshnessScore(row.last_upload_at);
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
