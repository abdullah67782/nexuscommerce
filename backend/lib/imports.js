// Shared import machinery for file uploads and store-connect imports.
//
// Identity (see docs/import-identity-and-coverage.md):
//   batch : data_uploads (uploaded_by, idempotency_key). The key is the client's
//           explicit operation id, or the content fingerprint when none is sent.
//           A rolled-back import KEEPS its key, so a delayed retry can never
//           silently restore it; a deliberate re-import needs a new operation id.
//   line  : sales (source_id, source_line_id) when the source supplies line ids.
//           Same id + same content = already imported; same id + different
//           content = explicit conflict (the whole import is refused).
//   row   : sales (upload_id, source_row_number) — every row of an import is
//           distinct, so genuine identical orders are kept.
// Rows without line ids that fall on a (product, date) already present from
// another import of the SAME source are refused unless overlap_mode = 'append'.
//
// Every import / rollback runs in one transaction holding a per-seller advisory
// lock, so imports, rollbacks and version numbers never interleave per seller.
const crypto = require('node:crypto');

const SELLER_LOCK_NAMESPACE = 7401;
const MAX_REPORTED = 20;

class ImportConflict extends Error {
  constructor(body) {
    super(body.message || body.error);
    this.status = 409;
    this.body = body;
  }
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// JSON with object keys sorted, so the same payload always has the same fingerprint.
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const lockSeller = (client, sellerId) =>
  client.query('SELECT pg_advisory_xact_lock($1, $2)', [SELLER_LOCK_NAMESPACE, sellerId]);

// ── Business dates ───────────────────────────────────────────────────────────
// Sale dates are business-local calendar days in the source's IANA timezone.
//   'YYYY-MM-DD'                       → that day, as written
//   'YYYY-MM-DD[T ]HH:MM[:SS]'         → local business time → its calendar day
//   ISO timestamp with Z / ±HH:MM      → converted to the source timezone's day
//   Excel serial number (from .xlsx)   → that calendar day
// Anything else (e.g. '10/01/23', ambiguous day/month order) is rejected.
const isValidTimezone = (tz) => {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};

const dayInZone = (date, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

const isCalendarDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

function businessDate(value, tz) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value < 2958466) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isCalendarDay(text) ? text : null;
  const local = text.match(/^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/);
  if (local) return isCalendarDay(local[1]) ? local[1] : null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : dayInZone(d, tz);
  }
  return null;
}

const todayIn = (tz) => dayInZone(new Date(), tz);

// ── Sources ──────────────────────────────────────────────────────────────────
// New sources default to Asia/Karachi (architect decision, 2026-10); each source
// keeps its own timezone and can be changed for future imports. Existing sources
// (backfilled as UTC by migration 002) and stored dates are never reinterpreted.
const FALLBACK_TIMEZONE = 'Asia/Karachi';
const defaultTimezone = () => {
  const tz = process.env.DEFAULT_BUSINESS_TIMEZONE || FALLBACK_TIMEZONE;
  return isValidTimezone(tz) ? tz : FALLBACK_TIMEZONE;
};

async function ensureSource(client, sellerId, { kind, provider, externalId, displayName = null, timezone = null }) {
  const tz = timezone || defaultTimezone();
  await client.query(
    `INSERT INTO data_sources (seller_id, kind, provider, external_id, display_name, timezone)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (seller_id, kind, provider, external_id) DO NOTHING`,
    [sellerId, kind, provider, externalId, displayName, tz],
  );
  const { rows } = await client.query(
    `SELECT id, timezone FROM data_sources
     WHERE seller_id = $1 AND kind = $2 AND provider = $3 AND external_id = $4`,
    [sellerId, kind, provider, externalId],
  );
  return rows[0];
}

// ── Batch identity ───────────────────────────────────────────────────────────
// Claim (seller, key) inside the caller's transaction. Returns the new import
// id, or null when the key already exists (caller then calls replayOf).
async function claimImport(client, { sellerId, sourceId, source, key, contentSha256, fileFormat, total, overlapMode }) {
  const { rows } = await client.query(
    `INSERT INTO data_uploads
       (uploaded_by, file_format, total_records, clean_records, source, source_id,
        idempotency_key, payload_sha256, content_sha256, overlap_mode)
     VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $7, $8)
     ON CONFLICT (uploaded_by, idempotency_key) DO NOTHING
     RETURNING id`,
    [sellerId, fileFormat, total, source, sourceId, key, contentSha256, overlapMode],
  );
  return rows.length ? rows[0].id : null;
}

// Result for a key that was already used. Same content → the original result
// (replayed: true; rolled_back says whether it was undone — never restored).
// Different content → explicit conflict.
async function replayOf(client, sellerId, key, contentSha256) {
  const { rows } = await client.query(
    `SELECT id, content_sha256, payload_sha256, result_summary, status
     FROM data_uploads WHERE uploaded_by = $1 AND idempotency_key = $2`,
    [sellerId, key],
  );
  const prior = rows[0];
  if (!prior) return null;
  const priorHash = prior.content_sha256 || prior.payload_sha256;
  if (priorHash !== contentSha256) {
    return { status: 409, body: {
      error: 'operation_id_conflict',
      message: 'This operation id was already used for different data. Use a new id for a new import.',
      import_record_id: prior.id,
    } };
  }
  return { status: 200, body: {
    ...prior.result_summary,
    replayed: true,
    rolled_back: prior.status === 'rolled_back',
  } };
}

// ── Rows ─────────────────────────────────────────────────────────────────────
const sameContent = (a, b) => a.product_id === b.productId && a.sale_date === b.saleDate
  && Number(a.quantity) === Number(b.quantity)
  && (a.revenue === null ? b.revenue === null : b.revenue !== null && Number(a.revenue) === Number(b.revenue));

// rows: [{ productId, productName, saleDate, quantity, revenue|null, lineId|null, rowNumber }]
async function insertSales(client, { importId, sourceId, rows, overlapMode }) {
  const result = { inserted: 0, alreadyImported: 0, identicalRowsKept: 0 };

  // 1. Line ids: compare with earlier deliveries and within this batch.
  const withLine = rows.filter(r => r.lineId);
  const conflicts = [];
  const skip = new Set();
  if (withLine.length) {
    const ids = [...new Set(withLine.map(r => r.lineId))];
    const { rows: existing } = await client.query(
      `SELECT source_line_id, product_id, to_char(sale_date, 'YYYY-MM-DD') AS sale_date, quantity, revenue, upload_id
       FROM sales WHERE source_id = $1 AND source_line_id = ANY($2)`,
      [sourceId, ids],
    );
    const byId = new Map(existing.map(e => [e.source_line_id, e]));
    const seen = new Map();
    for (const r of withLine) {
      const prior = byId.get(r.lineId);
      if (prior) {
        if (sameContent(prior, r)) skip.add(r);
        else conflicts.push({ line_id: r.lineId, row: r.rowNumber, existing_import_id: prior.upload_id });
        continue;
      }
      const earlier = seen.get(r.lineId);
      if (earlier) {
        const asStored = { product_id: earlier.productId, sale_date: earlier.saleDate, quantity: earlier.quantity, revenue: earlier.revenue };
        if (sameContent(asStored, r)) skip.add(r);
        else conflicts.push({ line_id: r.lineId, row: r.rowNumber, existing_import_id: null });
        continue;
      }
      seen.set(r.lineId, r);
    }
  }
  if (conflicts.length) {
    throw new ImportConflict({
      error: 'line_conflict',
      message: 'Some line ids were already imported with different contents. Nothing was imported.',
      conflicts: conflicts.slice(0, MAX_REPORTED),
      conflict_count: conflicts.length,
    });
  }

  // 2. Overlap for rows without line ids, within the same source only.
  const noLine = rows.filter(r => !r.lineId);
  if (noLine.length && overlapMode !== 'append') {
    const pairs = [...new Map(noLine.map(r => [`${r.productId}|${r.saleDate}`, r])).values()];
    // A day inside confirmed coverage of this source (migration 003) is already
    // complete, so new rows there are treated like rows on an existing day.
    const { rows: checked } = await client.query(
      `SELECT p.name AS product, to_char(want.sale_date, 'YYYY-MM-DD') AS sale_date,
              COALESCE((SELECT array_agg(DISTINCT s.upload_id) FROM sales s
                        WHERE s.source_id = $1 AND s.product_id = want.product_id
                          AND s.sale_date = want.sale_date AND s.upload_id IS DISTINCT FROM $4), '{}') AS existing_import_ids,
              EXISTS (SELECT 1 FROM data_coverage c
                      WHERE c.source_id = $1 AND c.status = 'confirmed'
                        AND want.sale_date BETWEEN c.declared_start AND c.declared_end
                        AND (c.scope = 'all_products' OR EXISTS (
                             SELECT 1 FROM data_coverage_products cp
                             WHERE cp.coverage_id = c.id AND cp.product_id = want.product_id))) AS inside_confirmed_coverage
       FROM unnest($2::int[], $3::date[]) AS want(product_id, sale_date)
       JOIN products p ON p.id = want.product_id
       ORDER BY want.sale_date, p.name`,
      [sourceId, pairs.map(r => r.productId), pairs.map(r => r.saleDate), importId],
    );
    const overlaps = checked.filter(o => o.existing_import_ids.length || o.inside_confirmed_coverage);
    if (overlaps.length) {
      throw new ImportConflict({
        error: 'overlap_requires_choice',
        message: 'Some rows fall on product/dates already imported from this source, or inside a period '
          + 'confirmed as complete, and have no line ids, so they cannot be matched to earlier rows. '
          + 'Nothing was imported. Re-send with '
          + 'overlap_mode = "append" if these are additional sales.',
        overlaps: overlaps.slice(0, MAX_REPORTED),
        overlap_count: overlaps.length,
      });
    }
  }

  // 3. Insert. Identical rows are distinct by row number.
  const counts = new Map();
  for (const r of rows) {
    if (skip.has(r)) { result.alreadyImported++; continue; }
    const sig = `${r.productId}|${r.saleDate}|${r.quantity}|${r.revenue}`;
    counts.set(sig, (counts.get(sig) || 0) + 1);
    await client.query(
      `INSERT INTO sales (product_id, quantity, sale_date, revenue, upload_id, source_id, source_line_id, source_row_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.productId, r.quantity, r.saleDate, r.revenue, importId, sourceId, r.lineId || null, r.rowNumber],
    );
    result.inserted++;
  }
  for (const n of counts.values()) if (n > 1) result.identicalRowsKept += n - 1;
  return result;
}

// ── Versions and freshness ───────────────────────────────────────────────────
async function addVersion(client, { sellerId, importId, added, skipped, rejected }) {
  const { rows } = await client.query(
    `INSERT INTO upload_versions (seller_id, upload_id, version_number, rows_added, rows_skipped, rows_rejected)
     SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3, $4, $5
     FROM upload_versions WHERE seller_id = $1
     RETURNING version_number`,
    [sellerId, importId, added, skipped, rejected],
  );
  return rows[0].version_number;
}

function freshnessScore(lastUploadAt) {
  if (!lastUploadAt) return 0;
  const days = (Date.now() - new Date(lastUploadAt).getTime()) / 86400000;
  if (days < 1) return 100;
  if (days <= 2) return 80;
  if (days <= 7) return 60;
  if (days <= 14) return 40;
  if (days <= 28) return 20;
  return 0;
}

// Recompute from committed imports and attributed sales (after imports AND rollbacks).
async function recomputeFreshness(client, sellerId) {
  const { rows } = await client.query(
    `SELECT (SELECT MAX(uploaded_at) FROM data_uploads WHERE uploaded_by = $1 AND status = 'committed') AS last_upload_at,
            (SELECT MAX(sale_date) FROM attributed_sales WHERE seller_id = $1) AS last_sale_date,
            (SELECT COUNT(*) FROM attributed_sales WHERE seller_id = $1)::int AS total`,
    [sellerId],
  );
  const { last_upload_at: lastUpload, last_sale_date: lastSale, total } = rows[0];
  await client.query(
    `INSERT INTO data_freshness (seller_id, last_upload_at, last_sale_date, total_records, freshness_score)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (seller_id) DO UPDATE SET
       last_upload_at = EXCLUDED.last_upload_at, last_sale_date = EXCLUDED.last_sale_date,
       total_records = EXCLUDED.total_records, freshness_score = EXCLUDED.freshness_score,
       updated_at = NOW()`,
    [sellerId, lastUpload, lastSale, total, freshnessScore(lastUpload)],
  );
}

// Products by name for one seller; a Map so any name is a plain key.
function productResolver(client, sellerId, importId) {
  const ids = new Map();
  let created = 0;
  const resolve = async (name, { category = null, price = null, updateDetails = false } = {}) => {
    if (ids.has(name)) {
      if (updateDetails && (category !== null || price !== null)) {
        await client.query(
          'UPDATE products SET current_price = COALESCE($1, current_price), category = COALESCE($2, category) WHERE id = $3',
          [price, category, ids.get(name)],
        );
      }
      return ids.get(name);
    }
    const existing = await client.query(
      'SELECT id FROM products WHERE user_id = $1 AND name = $2 ORDER BY id LIMIT 1', [sellerId, name]);
    let id;
    if (existing.rows.length) {
      id = existing.rows[0].id;
      if (updateDetails && (category !== null || price !== null)) {
        await client.query(
          'UPDATE products SET current_price = COALESCE($1, current_price), category = COALESCE($2, category) WHERE id = $3',
          [price, category, id],
        );
      }
    } else {
      const ins = await client.query(
        `INSERT INTO products (user_id, name, category, current_price, upload_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sellerId, name, category, price, importId],
      );
      id = ins.rows[0].id;
      created++;
    }
    ids.set(name, id);
    return id;
  };
  return { resolve, created: () => created };
}

module.exports = {
  ImportConflict, sha256, stableStringify, lockSeller,
  businessDate, todayIn, isValidTimezone, defaultTimezone,
  ensureSource, claimImport, replayOf, insertSales, addVersion,
  recomputeFreshness, freshnessScore, productResolver,
};
