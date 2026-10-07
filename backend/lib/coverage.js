// Confirmed data coverage (migration 003) and per-product history resolution.
//
// A coverage declaration says: this import contains ALL sales of its source for
// the inclusive business-local days [start, end], for all products
// ('all_products') or for the products named in the import ('listed_products').
//
// Day status for one product (sources = every source that has sold it):
//   covered  — inside a confirmed (not revoked) declaration of EVERY such source
//   recorded — not fully covered, but sales rows exist that day; the rows are
//              taken as that day's sales (the behaviour for all data before 003)
//   unknown  — neither: missing data, never treated as zero
// A day is KNOWN when it is covered or recorded; its value is the sum of the
// rows (0 only on covered days). Days before the product's first sale are not
// history. Unknown days are never filled with zero.
const { businessDate, todayIn } = require('./imports');

const SCOPES = ['all_products', 'listed_products'];
const DAY_MS = 86400000;

class CoverageError extends Error {
  constructor(status, body) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && businessDate(v, 'UTC') === v;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// Normalise a declaration from a request. Returns null when none was sent.
// raw: { start, end, scope, confirmed } (multipart sends strings).
function parseCoverage(raw, timezone) {
  if (raw === undefined || raw === null) return null;
  const provided = ['start', 'end', 'scope', 'confirmed'].some(k => raw[k] !== undefined && raw[k] !== '');
  if (!provided) return null;
  const confirmed = raw.confirmed === true || raw.confirmed === 'true';
  const bad = (message) => { throw new CoverageError(400, { error: 'invalid_coverage', message }); };
  if (!isDay(raw.start) || !isDay(raw.end)) bad('Coverage start and end must be dates in YYYY-MM-DD format.');
  if (raw.start > raw.end) bad('Coverage start must be on or before its end.');
  if (raw.end > todayIn(timezone)) bad(`Coverage cannot end after today (${todayIn(timezone)}, ${timezone}).`);
  if (!SCOPES.includes(raw.scope)) bad('Coverage scope must be "all_products" or "listed_products".');
  if (!confirmed) bad('Coverage must be explicitly confirmed (confirmed = true).');
  return { start: raw.start, end: raw.end, scope: raw.scope };
}

// Before writing: rows must lie inside the declared days, and the declaration must
// not overlap earlier rows or earlier confirmed coverage of the same source for the
// same products (that would need replacing a period, which is not supported yet).
async function checkCoverage(client, { sourceId, importId, coverage, rows, productIds }) {
  const outside = rows.filter(r => r.saleDate < coverage.start || r.saleDate > coverage.end);
  if (outside.length) {
    throw new CoverageError(400, {
      error: 'rows_outside_coverage',
      message: `${outside.length} row(s) are dated outside the confirmed period ${coverage.start} to ${coverage.end}. Nothing was imported.`,
      rows: outside.slice(0, 20).map(r => ({ row: r.rowNumber, sale_date: r.saleDate })),
    });
  }
  const all = coverage.scope === 'all_products';
  const { rows: earlierRows } = await client.query(
    `SELECT p.name AS product, to_char(MIN(s.sale_date), 'YYYY-MM-DD') AS first_date,
            to_char(MAX(s.sale_date), 'YYYY-MM-DD') AS last_date, COUNT(*)::int AS rows
     FROM sales s JOIN products p ON p.id = s.product_id
     WHERE s.source_id = $1 AND s.sale_date BETWEEN $2 AND $3 AND s.upload_id IS DISTINCT FROM $4
       AND ($5 OR s.product_id = ANY($6))
     GROUP BY p.name ORDER BY p.name LIMIT 20`,
    [sourceId, coverage.start, coverage.end, importId, all, productIds],
  );
  const { rows: earlierCoverage } = await client.query(
    `SELECT c.id, c.upload_id, to_char(c.declared_start, 'YYYY-MM-DD') AS start, to_char(c.declared_end, 'YYYY-MM-DD') AS end
     FROM data_coverage c
     WHERE c.source_id = $1 AND c.status = 'confirmed'
       AND c.declared_start <= $3 AND c.declared_end >= $2
       AND ($4 OR c.scope = 'all_products'
            OR EXISTS (SELECT 1 FROM data_coverage_products cp WHERE cp.coverage_id = c.id AND cp.product_id = ANY($5)))
     ORDER BY c.declared_start LIMIT 20`,
    [sourceId, coverage.start, coverage.end, all, productIds],
  );
  if (earlierRows.length || earlierCoverage.length) {
    throw new CoverageError(409, {
      error: 'coverage_overlaps_existing_data',
      message: 'This source already has sales or a confirmed period inside these dates. A complete export for '
        + 'the period would count those sales twice, and replacing a period is not supported yet. Nothing was imported.',
      existing_rows: earlierRows,
      existing_coverage: earlierCoverage,
    });
  }
}

async function recordCoverage(client, { sellerId, sourceId, importId, coverage, productIds, evidence }) {
  const { rows } = await client.query(
    `INSERT INTO data_coverage (seller_id, source_id, upload_id, scope, declared_start, declared_end, evidence, declared_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $1) RETURNING id`,
    [sellerId, sourceId, importId, coverage.scope, coverage.start, coverage.end, evidence],
  );
  const coverageId = rows[0].id;
  if (coverage.scope === 'listed_products') {
    await client.query(
      `INSERT INTO data_coverage_products (coverage_id, product_id, seller_id)
       SELECT $1, unnest($2::int[]), $3`,
      [coverageId, productIds, sellerId],
    );
  }
  return {
    coverage_id: coverageId, start: coverage.start, end: coverage.end, scope: coverage.scope,
    days: daysBetween(coverage.start, coverage.end) + 1,
    products: coverage.scope === 'listed_products' ? productIds.length : 'all',
  };
}

async function revokeForImport(client, { sellerId, importId, reason = 'rollback' }) {
  const { rowCount } = await client.query(
    `UPDATE data_coverage SET status = 'revoked', revoked_by = $1, revoked_at = NOW(), revoke_reason = $3
     WHERE seller_id = $1 AND upload_id = $2 AND status = 'confirmed'`,
    [sellerId, importId, reason],
  );
  return rowCount;
}

// ── History resolution ───────────────────────────────────────────────────────
// Returns the product's day-by-day status and its usable history: the run of
// consecutive known days that ends on the last known day.
async function productHistory(db, sellerId, productId) {
  const { rows: sales } = await db.query(
    `SELECT to_char(sale_date, 'YYYY-MM-DD') AS day, source_id, SUM(quantity)::bigint AS quantity
     FROM attributed_sales WHERE seller_id = $1 AND product_id = $2
     GROUP BY sale_date, source_id ORDER BY sale_date`,
    [sellerId, productId],
  );
  if (!sales.length) return { first_sale: null, usable: null, gaps: [], counts: { covered: 0, recorded: 0, unknown: 0 }, sources: [] };

  const sourceKey = (id) => (id === null ? 'legacy' : String(id));
  const sourceIds = [...new Set(sales.map(r => r.source_id))];
  const { rows: coverage } = await db.query(
    `SELECT c.source_id, to_char(c.declared_start, 'YYYY-MM-DD') AS start, to_char(c.declared_end, 'YYYY-MM-DD') AS end
     FROM data_coverage c
     WHERE c.seller_id = $1 AND c.status = 'confirmed' AND c.source_id = ANY($2)
       AND (c.scope = 'all_products'
            OR EXISTS (SELECT 1 FROM data_coverage_products cp WHERE cp.coverage_id = c.id AND cp.product_id = $3))
     ORDER BY c.declared_start`,
    [sellerId, sourceIds.filter(id => id !== null), productId],
  );
  const { rows: sourceRows } = await db.query(
    'SELECT id, kind, display_name, timezone FROM data_sources WHERE seller_id = $1 AND id = ANY($2)',
    [sellerId, sourceIds.filter(id => id !== null)],
  );

  const firstSale = sales[0].day;
  const lastRecorded = sales[sales.length - 1].day;
  const lastCovered = coverage.reduce((m, c) => (c.end > m ? c.end : m), lastRecorded);
  const length = daysBetween(firstSale, lastCovered) + 1;

  const recorded = new Map(sourceIds.map(id => [sourceKey(id), new Set()]));
  const totals = new Array(length).fill(0);
  for (const r of sales) {
    const i = daysBetween(firstSale, r.day);
    recorded.get(sourceKey(r.source_id)).add(i);
    totals[i] += Number(r.quantity);
  }
  const covered = new Map(sourceIds.map(id => [sourceKey(id), new Uint8Array(length)]));
  for (const c of coverage) {
    const mask = covered.get(sourceKey(c.source_id));
    const from = Math.max(0, daysBetween(firstSale, c.start));
    const to = Math.min(length - 1, daysBetween(firstSale, c.end));
    for (let i = from; i <= to; i++) mask[i] = 1;
  }

  const status = new Array(length);
  const counts = { covered: 0, recorded: 0, unknown: 0 };
  const hasRows = new Uint8Array(length);
  for (const set of recorded.values()) for (const i of set) hasRows[i] = 1;
  for (let i = 0; i < length; i++) {
    const allCovered = sourceIds.every(id => covered.get(sourceKey(id))[i]);
    const state = allCovered ? 'covered' : hasRows[i] ? 'recorded' : 'unknown';
    status[i] = state;
    counts[state]++;
  }

  let last = length - 1;
  while (last >= 0 && status[last] === 'unknown') last--;
  let first = last;
  while (first > 0 && status[first - 1] !== 'unknown') first--;

  const gaps = [];
  for (let i = 0; i <= last; i++) {
    if (status[i] !== 'unknown') continue;
    let j = i;
    while (j + 1 <= last && status[j + 1] === 'unknown') j++;
    gaps.push({ start: addDays(firstSale, i), end: addDays(firstSale, j), days: j - i + 1 });
    i = j;
  }
  const run = status.slice(first, last + 1);
  return {
    first_sale: firstSale,
    usable: {
      start: addDays(firstSale, first), end: addDays(firstSale, last), days: last - first + 1,
      quantities: totals.slice(first, last + 1),
      covered_days: run.filter(s => s === 'covered').length,
      recorded_days: run.filter(s => s === 'recorded').length,
    },
    gaps,
    counts,
    sources: sourceIds.map(id => {
      const meta = sourceRows.find(s => s.id === id);
      return {
        id, kind: meta?.kind || 'legacy', name: meta?.display_name || (id === null ? 'Earlier data (no import record)' : null),
        timezone: meta?.timezone || null,
        confirmed_periods: coverage.filter(c => c.source_id === id).map(c => ({ start: c.start, end: c.end })),
      };
    }),
  };
}

module.exports = {
  CoverageError, SCOPES, parseCoverage, checkCoverage, recordCoverage, revokeForImport, productHistory,
  addDays, daysBetween, isDay,
};
