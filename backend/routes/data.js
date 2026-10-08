const express = require('express');
const multer = require('multer');
const csvParser = require('csv-parser');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const {
  ImportConflict, sha256, stableStringify, lockSeller, businessDate, todayIn, ensureSource, claimImport,
  replayOf, insertSales, addVersion, recomputeFreshness, productResolver, freshnessScore,
  defaultTimezone, isValidTimezone,
} = require('../lib/imports');
const { CoverageError, parseCoverage, checkCoverage, recordCoverage, revokeForImport, confirmExistingImport } = require('../lib/coverage');

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

// ─── Cleaning rules (docs/data-cleaning-requirements.md) ─────────────────────
// Nothing is invented and no genuine sale is removed:
//   - a missing, non-numeric, zero, negative or fractional quantity rejects the row
//     (whole-unit products only), with a reported anomaly;
//   - a missing revenue stays empty; a missing price or stock level leaves the
//     product's stored value unchanged (no median imputation);
//   - unusually large orders are KEPT and flagged for review (flagLargeOrders).
function cleanData(rawRows) {
  return { cleanedRows: normalizeKeys(rawRows), report: { total_records: rawRows.length } };
}

const LARGE_ORDER_MIN_ROWS = 8;   // per product in this import
const quantile = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)];

// Flags orders far above the product's usual order size in this import:
// quantity > Q3 + 3 x max(IQR, 1). Flagged rows are still imported.
function flagLargeOrders(rows) {
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  const flagged = [];
  for (const group of byProduct.values()) {
    if (group.length < LARGE_ORDER_MIN_ROWS) continue;
    const sorted = group.map(r => r.quantity).sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const threshold = q3 + 3 * Math.max(q3 - q1, 1);
    for (const r of group) if (r.quantity > threshold) flagged.push({ ...r, threshold });
  }
  return flagged;
}

const ACCEPTED_DATE_FORMATS = [
  'YYYY-MM-DD (e.g. 2026-03-14)',
  'YYYY-MM-DD HH:MM[:SS] — local time of the store',
  'ISO timestamp with Z or ±HH:MM (e.g. 2026-03-14T18:30:00+05:00)',
  'Excel date cells',
];

// ─── Per-Row Validation ──────────────────────────────────────────────────────
// Sale dates are business-local days in the source timezone (lib/imports.js).

function validateRow(row, timezone) {
  const anomalies = [];
  const rowNumber   = row[ROW];
  const productName = row.product_name || row.name || null;
  const rawQuantity = row.quantity;
  const quantityMissing = rawQuantity === undefined || rawQuantity === null || String(rawQuantity).trim() === '';
  const quantity    = quantityMissing ? NaN : Number(String(rawQuantity).trim());
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
  if (quantityMissing || !Number.isFinite(quantity) || quantity <= 0) {
    const type = quantityMissing ? 'missing_quantity'
      : !Number.isFinite(quantity) ? 'invalid_quantity'
      : quantity < 0 ? 'negative_value' : 'zero_quantity';
    push('quantity', type, rawQuantity, 'critical');
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
// Multipart: file, optional operation_id (identity of THIS upload action),
// optional overlap_mode ('reject' default | 'append') and optional confirmed
// coverage: coverage_start, coverage_end (YYYY-MM-DD, inclusive, business days of
// the file source), coverage_scope ('all_products' | 'listed_products') and
// coverage_confirmed = 'true'. With coverage, a file with no sales rows is a valid
// "nothing was sold" export (scope all_products).
// No operation_id: identity is the fingerprint of the file (and of the coverage
// declaration, when one is sent), so re-sending the same upload replays the
// original result. A new operation_id is a deliberate new import; overlaps with
// earlier rows or confirmed periods of the same source are then refused unless
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
  const coverageInput = {
    start: req.body?.coverage_start, end: req.body?.coverage_end,
    scope: req.body?.coverage_scope, confirmed: req.body?.coverage_confirmed,
  };
  const coverageSent = Object.values(coverageInput).some(v => v !== undefined && v !== '');

  let rawData;
  let contentSha;
  try {
    contentSha = sha256(fs.readFileSync(filePath));
    rawData = await parseFile(filePath);
  } catch (err) {
    cleanup();
    return res.status(400).json({ error: 'File could not be parsed', details: err.message });
  }
  if (!Array.isArray(rawData) || (rawData.length === 0 && !coverageSent)) {
    cleanup();
    return res.status(400).json({
      error: 'File is empty or could not be parsed',
      message: 'A file without sales rows is accepted only with a confirmed period showing that nothing was sold.',
    });
  }
  if (coverageSent) contentSha = sha256(`${contentSha}|coverage:${stableStringify(coverageInput)}`);

  const { cleanedRows, report } = cleanData(rawData);
  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const key = operationId ? `file-op:${operationId}` : `file-content:${contentSha}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, sellerId);
    const source = await ensureSource(client, sellerId, {
      kind: 'file', provider: 'file_upload', externalId: 'default', displayName: 'File uploads',
    });
    const coverage = parseCoverage(coverageSent ? coverageInput : null, source.timezone);

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
    const productIds = new Set();
    const anomalies = [];
    const rows = [];
    const invalidDates = [];
    let rejected = 0;
    let withoutDate = 0;

    for (const row of cleanedRows) {
      const v = validateRow(row, source.timezone);
      anomalies.push(...v.anomalies);
      if (!v.valid) {
        rejected++;
        const bad = v.anomalies.find(a => a.anomaly_type === 'invalid_date');
        if (bad) invalidDates.push({ row: bad.row_number, value: bad.original_value });
        continue;
      }

      const productId = await products.resolve(v.productName, {
        category: v.category, price: v.price, updateDetails: true,
      });
      productIds.add(productId);
      if (v.saleDate) {
        rows.push({ productId, productName: v.productName, saleDate: v.saleDate, quantity: v.quantity,
          revenue: v.revenue, lineId: v.lineId, rowNumber: v.rowNumber });
      } else {
        withoutDate++;
      }

      // Inventory snapshot: the last row for a product wins (unchanged behaviour).
      // A missing stock level leaves the stored one unchanged.
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

    // Large orders are kept; they are flagged for the seller to review.
    const largeOrders = flagLargeOrders(rows);
    for (const o of largeOrders) {
      anomalies.push({ product_name: o.productName, field: 'quantity', anomaly_type: 'unusually_large_order',
        original_value: `${o.quantity} (usual orders in this file up to ${o.threshold})`, row_number: o.rowNumber,
        severity: 'warning' });
    }

    const listed = [...productIds];
    if (coverage) {
      // A period confirmed as complete must not silently lose rows.
      if (rejected) {
        throw new CoverageError(400, {
          error: 'coverage_with_rejected_rows',
          message: `${rejected} row(s) could not be imported, so this file cannot be confirmed as complete for `
            + `${coverage.start} to ${coverage.end}. Fix those rows, or upload without confirming the period. Nothing was imported.`,
          rejected_rows: anomalies.filter(a => a.severity === 'critical').slice(0, 20)
            .map(a => ({ row: a.row_number, problem: a.anomaly_type, value: a.original_value })),
          date_help: invalidDates.length ? { accepted_formats: ACCEPTED_DATE_FORMATS } : undefined,
        });
      }
      if (coverage.scope === 'listed_products' && !listed.length) {
        throw new CoverageError(400, { error: 'invalid_coverage',
          message: 'A period for the listed products needs at least one product in the file. Use all products for an export with no sales.' });
      }
      await checkCoverage(client, { sourceId: source.id, importId: uploadId, coverage, rows, productIds: listed });
    }

    const result = await insertSales(client, { importId: uploadId, sourceId: source.id, rows, overlapMode });
    const coverageSummary = coverage
      ? await recordCoverage(client, { sellerId, sourceId: source.id, importId: uploadId, coverage,
          productIds: listed, evidence: 'seller_declaration' })
      : null;

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
    const total = report.total_records;
    const qualityScore = total > 0 ? Number((((total - rejected) / total) * 100).toFixed(2)) : 100;
    const summary = {
      message:            'File uploaded and processed successfully',
      total_rows:         total,
      inserted:           result.inserted,
      skipped:            result.alreadyImported,
      rejected,
      identical_rows_kept: result.identicalRowsKept,
      rows_without_sale_date: withoutDate,
      large_orders_flagged: largeOrders.length,
      quality_score:      qualityScore,
      version_number:     versionNumber,
      upload_id:          uploadId,
      anomaly_count:      anomalies.length,
      source_id:          source.id,
      source_timezone:    source.timezone,
      coverage:           coverageSummary,
      date_help: invalidDates.length ? {
        message: `${invalidDates.length} row(s) have dates that could not be read safely. Dates such as 03/04/2026 are `
          + 'ambiguous (3 April or March 4?), so they are not guessed. Write dates as YYYY-MM-DD, for example 2026-04-03.',
        accepted_formats: ACCEPTED_DATE_FORMATS,
        examples: invalidDates.slice(0, 5),
      } : null,
    };
    await client.query(
      'UPDATE data_uploads SET clean_records = $2, quality_score = $3, result_summary = $4 WHERE id = $1',
      [uploadId, total - rejected, qualityScore, summary]);
    await recomputeFreshness(client, sellerId);
    await client.query('COMMIT');
    res.status(200).json({ ...summary, replayed: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof ImportConflict || err instanceof CoverageError) return res.status(err.status).json(err.body);
    console.error('Upload error:', err.message);
    res.status(500).json({ error: 'Error processing uploaded file', details: err.message });
  } finally {
    client.release();
    cleanup();
  }
});

// ─── POST /api/data/uploads/:uploadId/coverage ───────────────────────────────
// Confirm that an upload already stored contains EVERY sale of its source for
// { start, end, scope, confirmed: true }. Until a period is confirmed, its days
// stay visible as sales but do not count as forecasting history.
router.post('/data/uploads/:uploadId/coverage', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const importId = parseInt(req.params.uploadId, 10);
  if (!Number.isInteger(importId)) return res.status(400).json({ error: 'Invalid upload id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, sellerId);
    const coverage = await confirmExistingImport(client, { sellerId, importId, input: req.body || {} });
    await client.query('COMMIT');
    res.json({ status: 'confirmed', upload_id: importId, coverage });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof CoverageError) return res.status(err.status).json(err.body);
    console.error('Confirm coverage error:', err.message);
    res.status(500).json({ error: 'Error confirming coverage' });
  } finally {
    client.release();
  }
});

// ─── GET /api/data/sources ───────────────────────────────────────────────────
// The seller's import sources with their business timezone.
router.get('/data/sources', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, provider, external_id, display_name, timezone, created_at
     FROM data_sources WHERE seller_id = $1 ORDER BY id`, [req.user.id]);
  res.json({ sources: rows, default_timezone: defaultTimezone() });
});

// ─── PATCH /api/data/sources/:id ─────────────────────────────────────────────
// Change a source's timezone. Applies to FUTURE imports only: stored sale dates
// are business days and are never reinterpreted.
router.patch('/data/sources/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tz = req.body?.timezone;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid source id' });
  if (typeof tz !== 'string' || !isValidTimezone(tz)) {
    return res.status(400).json({ error: 'timezone must be a valid IANA timezone, e.g. Asia/Karachi' });
  }
  const { rows } = await pool.query(
    'UPDATE data_sources SET timezone = $1 WHERE id = $2 AND seller_id = $3 RETURNING id, kind, display_name, timezone',
    [tz, id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Source not found' });
  res.json({ ...rows[0], note: 'Applies to future imports; stored dates are unchanged.' });
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
              du.quality_score, du.file_format, du.total_records, du.source,
              to_char(dc.declared_start, 'YYYY-MM-DD') AS coverage_start,
              to_char(dc.declared_end, 'YYYY-MM-DD') AS coverage_end, dc.scope AS coverage_scope,
              (SELECT to_char(MIN(s.sale_date), 'YYYY-MM-DD') FROM sales s WHERE s.upload_id = du.id) AS first_sale_date,
              (SELECT to_char(MAX(s.sale_date), 'YYYY-MM-DD') FROM sales s WHERE s.upload_id = du.id) AS last_sale_date
       FROM upload_versions uv
       JOIN data_uploads du ON du.id = uv.upload_id
       LEFT JOIN data_coverage dc ON dc.upload_id = du.id AND dc.status = 'confirmed'
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
    const revoked = await revokeForImport(client, { sellerId, importId: uploadId }); // its coverage no longer holds

    await recomputeFreshness(client, sellerId);
    await client.query('COMMIT');
    res.json({ status: 'success', rolled_back_rows: delSales.rows.length, coverage_revoked: revoked });
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
