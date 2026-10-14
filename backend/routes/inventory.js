// /api/inventory — Stage 1a stock ledger (counts, movements, settings, readiness).
// Accounting rules: lib/stockLedger.js. Readiness: lib/inventoryReadiness.js.
// Every write runs in one transaction holding the per-seller advisory lock, the
// seller always comes from the token, and another seller's ids answer 404.
const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { upload, parseFile } = require('../lib/files');
const { sha256, stableStringify, claimImport, replayOf, addVersion, lockSeller, defaultTimezone, todayIn } = require('../lib/imports');
const ledger = require('../lib/stockLedger');
const readiness = require('../lib/inventoryReadiness');
const purchasing = require('../lib/purchasing');

const { InventoryError, parseInstant, wholeQuantity } = ledger;
const router = express.Router();
const MAX_ITEMS = 5000;
const MAX_EVENTS = 1000;
const MAX_REPORTED = 50;

const fail = (res, err, what) => {
  if (err instanceof InventoryError) return res.status(err.status).json(err.body);
  console.error(`Inventory ${what} error:`, err.message);
  return res.status(500).json({ error: 'server_error', message: `Error ${what}.` });
};

// Reads never create rows: a seller without a location gets the defaults.
async function readLocation(db, sellerId) {
  const { rows } = await db.query(
    'SELECT id, name, timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  return rows[0] || { id: null, name: 'Main location', timezone: defaultTimezone() };
}

function validKey(value, field = 'idempotency_key') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new InventoryError(400, { error: 'invalid_request', message: `${field} must be a non-empty string of at most 200 characters.` });
  }
  return value.trim();
}

const asBool = (v) => v === true || v === 'true' || v === '1' || v === 1;

async function withTransaction(sellerId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockSeller(client, sellerId);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Building items ───────────────────────────────────────────────────────────
function itemFrom(product, pos, policy) {
  const assessed = readiness.assess(pos, policy);
  return {
    product_id: product.id,
    name: product.name,
    category: product.category,
    stock: {
      known: pos.known,
      on_hand: pos.on_hand,
      position_type: pos.known ? (pos.movement_tracking === 'complete' ? 'tracked' : 'last_known') : null,
      measure: 'physical_on_hand',
      available_to_sell: 'not_tracked',
      last_count: pos.last_count,
      movement_tracking: pos.movement_tracking,
      events_since_count: pos.events_since_count,
      net_change_since_count: pos.net_change_since_count,
      events_included_in_count: pos.events_included_in_count,
      events_without_count: pos.events_without_count,
      untracked_sales_since_count: pos.untracked_sales_since_count,
      legacy: pos.legacy,
    },
    policy: {
      reorder_threshold: policy.reorder_threshold, stale_after_days: policy.stale_after_days,
      threshold_source: policy.threshold_source,
    },
    readiness: {
      stock: assessed.stock, reconciliation: assessed.reconciliation,
      commitments: assessed.commitments, policy: assessed.policy, overall: assessed.overall,
    },
    threshold_alert: assessed.threshold_alert,
  };
}

async function loadItems(db, sellerId, productIds = null) {
  const location = await readLocation(db, sellerId);
  const { rows: products } = await db.query(
    `SELECT id, name, category FROM products WHERE user_id = $1 AND ($2::int[] IS NULL OR id = ANY($2::int[]))
     ORDER BY name, id`, [sellerId, productIds]);
  const pos = await ledger.positions(db, sellerId, location, productIds);
  const pol = await ledger.policies(db, sellerId, location, productIds);
  const today = todayIn(location.timezone);
  const inbound = await purchasing.inboundByProduct(db, sellerId, productIds, today);
  const terms = await purchasing.supplierTermsByProduct(db, sellerId, productIds);
  const items = products.map((p) => {
    const item = itemFrom(p, pos.get(p.id), pol.forProduct(p.id));
    const inb = inbound.get(p.id);
    const t = terms.get(p.id);
    // Incoming stock is reported beside on-hand, never added to it.
    item.inbound = {
      open_quantity: inb?.open_quantity || 0, approved_not_sent: inb?.approved_not_sent || 0,
      open_orders: inb?.open_orders || 0, next_expected: inb?.next_expected || null,
      overdue_quantity: inb?.overdue_quantity || 0, no_date_quantity: inb?.no_date_quantity || 0,
    };
    item.supplier = t ? { id: t.supplier_id, name: t.supplier_name, preferred: t.is_preferred, lead_time_days: t.lead_time_days,
      unit_cost: t.unit_cost === null ? null : Number(t.unit_cost), currency: t.currency, pack_size: t.pack_size,
      min_order_qty: t.min_order_qty, active_links: t.active_links } : null;
    item.readiness.inbound = purchasing.inboundDimension(inb);
    item.readiness.supplier = purchasing.supplierDimension(t);
    return item;
  });
  return { location, items, policyOf: (id) => pol.forProduct(id), sellerDefault: pol.sellerDefault };
}

async function addSalesHistory(db, sellerId, location, item) {
  const full = await readiness.withSalesHistory(db, sellerId, location, item.product_id,
    { ...item.readiness }, { stale_after_days: item.policy.stale_after_days });
  return { ...item, readiness: { ...item.readiness, sales_history: full.sales_history } };
}

// ─── GET /api/inventory/items ────────────────────────────────────────────────
const STATE_FILTERS = ['missing', 'unverified_only', 'inconsistent', 'stale', 'last_known', 'tracked',
  'below_threshold', 'needs_review', 'unknown_stock', 'inbound', 'inbound_overdue'];

router.get('/items', authMiddleware, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 50));
    const state = req.query.state || null;
    if (state && !STATE_FILTERS.includes(state)) {
      return res.status(400).json({ error: 'invalid_request', message: `state must be one of ${STATE_FILTERS.join(', ')}.` });
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const { location, items, sellerDefault } = await loadItems(pool, sellerId);

    const counts = {
      products: items.length,
      unknown_stock: items.filter(i => !i.stock.known).length,
      missing: items.filter(i => i.readiness.stock.state === 'missing').length,
      unverified_only: items.filter(i => i.readiness.stock.state === 'unverified_only').length,
      inconsistent: items.filter(i => i.readiness.stock.state === 'inconsistent').length,
      stale: items.filter(i => i.readiness.stock.state === 'stale').length,
      last_known: items.filter(i => i.readiness.stock.state === 'last_known').length,
      tracked: items.filter(i => i.readiness.stock.state === 'tracked').length,
      below_threshold: items.filter(i => i.threshold_alert === 'below').length,
      needs_review: items.filter(i => i.readiness.reconciliation.state === 'needs_review').length,
      inbound: items.filter(i => i.inbound.open_quantity > 0).length,
      inbound_overdue: items.filter(i => i.inbound.overdue_quantity > 0).length,
      no_supplier: items.filter(i => !i.supplier).length,
    };
    const matches = items.filter((i) => {
      if (q && !String(i.name).toLowerCase().includes(q)) return false;
      if (!state) return true;
      if (state === 'below_threshold') return i.threshold_alert === 'below';
      if (state === 'needs_review') return i.readiness.reconciliation.state === 'needs_review';
      if (state === 'unknown_stock') return !i.stock.known;
      if (state === 'inbound') return i.inbound.open_quantity > 0;
      if (state === 'inbound_overdue') return i.inbound.overdue_quantity > 0;
      return i.readiness.stock.state === state;
    });
    const slice = matches.slice((page - 1) * pageSize, page * pageSize);
    const withHistory = [];
    for (const item of slice) withHistory.push(await addSalesHistory(pool, sellerId, location, item));
    res.json({
      items: withHistory, page, page_size: pageSize, total: matches.length, counts,
      location: { id: location.id, name: location.name, timezone: location.timezone },
      seller_default: sellerDefault,
      notes: [
        'On-hand is physical stock at this location. Reservations and backorders are not tracked, so it is not available-to-sell stock.',
        'Sales uploads never change stock. Stock comes only from counts and recorded movements.',
        'Incoming purchase-order quantities are shown separately; they enter on-hand only when received.',
      ],
    });
  } catch (err) { fail(res, err, 'loading inventory'); }
});

// ─── GET /api/inventory/items/:productId ─────────────────────────────────────
router.get('/items/:productId', authMiddleware, async (req, res) => {
  try {
    const sellerId = req.user.id;
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(404).json({ error: 'not_found', message: 'Product not found.' });
    const { location, items } = await loadItems(pool, sellerId, [productId]);
    if (!items.length) return res.status(404).json({ error: 'not_found', message: 'Product not found.' });
    const item = await addSalesHistory(pool, sellerId, location, items[0]);
    const selected = item.stock.last_count;

    const { rows: counts } = await pool.query(
      `SELECT s.id, s.quantity, s.observed_at, s.verification, s.status, s.superseded_by,
              to_char(s.legacy_recorded_at, 'YYYY-MM-DD HH24:MI') AS legacy_written_at_server_time,
              b.id AS batch_id, b.source_kind, b.source_id, b.upload_id, b.recorded_at, b.status AS batch_status,
              b.revoke_reason, b.revoked_at
       FROM stock_snapshots s JOIN stock_snapshot_batches b ON b.id = s.batch_id
       WHERE s.seller_id = $1 AND s.product_id = $2
       ORDER BY s.observed_at DESC NULLS LAST, s.id DESC LIMIT 100`, [sellerId, productId]);
    const { rows: movements } = await pool.query(
      `SELECT id, kind, quantity, effective_at, recorded_at, source_id, external_event_id, order_ref, reason
       FROM stock_movements WHERE seller_id = $1 AND product_id = $2
       ORDER BY effective_at DESC, id DESC LIMIT 200`, [sellerId, productId]);
    const selectedAt = selected ? new Date(selected.observed_at).getTime() : null;
    const { rows: legacy } = await pool.query(
      `SELECT inventory_id, stock_level, reorder_threshold, to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS written_at_server_time, outcome
       FROM inventory_legacy_rows
       WHERE owner_id = $1 AND product_id = $2 ORDER BY inventory_id`, [sellerId, productId]);

    res.json({
      ...item,
      location: { id: location.id, name: location.name, timezone: location.timezone },
      counts: counts.map(c => ({
        ...c,
        observed_at: c.observed_at ? new Date(c.observed_at).toISOString() : null,
        selected: selected ? c.id === selected.snapshot_id : false,
      })),
      // Relation to the CURRENTLY selected count, computed now — never stored.
      movements: movements.map((m) => {
        const t = new Date(m.effective_at).getTime();
        let relation = 'no_count';
        if (selectedAt !== null) relation = t > selectedAt ? 'after_count' : t === selectedAt ? 'at_count_included' : 'before_count_included';
        return { ...m, effective_at: new Date(m.effective_at).toISOString(), relation };
      }),
      legacy_evidence: legacy,
    });
  } catch (err) { fail(res, err, 'loading the product'); }
});

// ─── POST /api/inventory/snapshots ───────────────────────────────────────────
// { idempotency_key, observed_at, source_id?, supersede?, items: [{ product_id | product_name, quantity }] }
router.post('/snapshots', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const body = req.body || {};
    const key = validKey(body.idempotency_key);
    const observedAt = parseInstant(body.observed_at, 'observed_at');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_ITEMS) {
      throw new InventoryError(400, { error: 'invalid_request', message: `items must list 1 to ${MAX_ITEMS} products.` });
    }
    const sourceId = body.source_id === undefined || body.source_id === null ? null : Number(body.source_id);
    const result = await withTransaction(sellerId, async (client) => {
      const location = await ledger.ensureDefaultLocation(client, sellerId);
      if (sourceId !== null) {
        const { rows } = await client.query(
          `SELECT m.reports_physical_on_hand, m.location_id FROM data_sources ds
           LEFT JOIN inventory_source_mappings m ON m.source_id = ds.id AND m.seller_id = ds.seller_id
           WHERE ds.id = $1 AND ds.seller_id = $2`, [Number.isInteger(sourceId) ? sourceId : -1, sellerId]);
        if (!rows.length) throw new InventoryError(404, { error: 'not_found', message: 'Source not found.' });
        if (!rows[0].reports_physical_on_hand || rows[0].location_id !== location.id) {
          throw new InventoryError(422, { error: 'source_not_physical_stock',
            message: 'This source is not declared to report physical on-hand stock for this location. '
              + 'A channel\'s "available" quantity is not a physical count. Declare it in the source settings first.' });
        }
      }
      const resolve = await ledger.resolveProducts(client, sellerId, body.items);
      const errors = [];
      const seen = new Map();
      body.items.forEach((raw, index) => {
        const productId = resolve(raw || {});
        if (!productId) { errors.push({ index, problem: 'product_not_found' }); return; }
        const q = wholeQuantity(raw.quantity);
        if (q.error) { errors.push({ index, product_id: productId, problem: q.error }); return; }
        if (seen.has(productId)) { errors.push({ index, product_id: productId, problem: 'duplicate_product' }); return; }
        seen.set(productId, q.value);
      });
      if (errors.length) {
        throw new InventoryError(400, { error: 'invalid_items',
          message: 'Some items are invalid. Nothing was recorded. Each product may appear once per count.',
          errors: errors.slice(0, MAX_REPORTED), error_count: errors.length });
      }
      return ledger.recordCounts(client, {
        sellerId, userId: sellerId, kind: sourceId === null ? 'manual_count' : 'connector',
        idempotencyKey: `${sourceId === null ? 'count' : `connector-${sourceId}`}:${key}`, observedAt, sourceId,
        location, supersede: asBool(body.supersede),
        items: [...seen.entries()].map(([productId, quantity]) => ({ productId, quantity })),
      });
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (err) { fail(res, err, 'recording the count'); }
});

// ─── POST /api/inventory/snapshots/:batchId/revoke ───────────────────────────
// Undo a whole count submission. Count files are undone with Data Integration rollback.
router.post('/snapshots/:batchId/revoke', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const batchId = Number(req.params.batchId);
    const out = await withTransaction(sellerId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, source_kind, status FROM stock_snapshot_batches WHERE id = $1 AND seller_id = $2',
        [Number.isInteger(batchId) ? batchId : -1, sellerId]);
      if (!rows.length) throw new InventoryError(404, { error: 'not_found', message: 'Count not found.' });
      const batch = rows[0];
      if (batch.source_kind === 'legacy_migration') {
        throw new InventoryError(400, { error: 'legacy_not_revocable',
          message: 'Migrated legacy values are evidence and stay unverified; record a count instead.' });
      }
      if (batch.source_kind === 'count_file') {
        throw new InventoryError(400, { error: 'use_rollback',
          message: 'This count came from a stock-count file. Roll back that import on the Data Integration page.' });
      }
      if (batch.status === 'revoked') return { batch_id: batch.id, revoked: 0, already_revoked: true };
      const revoked = await ledger.revokeBatch(client, { sellerId, userId: sellerId, batchId: batch.id, reason: 'seller_revoked' });
      return { batch_id: batch.id, revoked, already_revoked: false };
    });
    res.json(out);
  } catch (err) { fail(res, err, 'revoking the count'); }
});

// ─── POST /api/inventory/count-files ─────────────────────────────────────────
// Multipart: file (product_name, quantity), counted_at, operation_id?, supersede?
// A stock-count file is an import version (rolled back on Data Integration). It
// never creates products and never touches sales. Rejected rows are reported as
// warnings (they do not affect sales or forecasts). Partial files are allowed:
// products not listed are unchanged (no implicit zero).
function normalise(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')] = row[k];
  return out;
}

router.post('/count-files', authMiddleware, upload.single('file'), async (req, res) => {
  const sellerId = req.user.id;
  if (!req.file) return res.status(400).json({ error: 'invalid_request', message: 'No file uploaded. Send a file with key "file".' });
  const filePath = req.file.path;
  const cleanup = () => fs.unlink(filePath, () => {});
  try {
    const countedAt = parseInstant(req.body?.counted_at, 'counted_at');
    const operationId = req.body?.operation_id ? validKey(req.body.operation_id, 'operation_id') : null;
    const supersede = asBool(req.body?.supersede);
    let raw;
    let fileSha;
    try {
      fileSha = sha256(fs.readFileSync(filePath));
      raw = await parseFile(filePath);
    } catch (e) {
      throw new InventoryError(400, { error: 'unreadable_file', message: `The file could not be read: ${e.message}` });
    }
    if (!Array.isArray(raw) || !raw.length) throw new InventoryError(400, { error: 'empty_file', message: 'The file has no rows.' });
    const contentSha = sha256(`${fileSha}|stock_count:${stableStringify({ countedAt, supersede })}`);
    const key = operationId ? `count-file-op:${operationId}` : `count-file-content:${contentSha}`;
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');

    const result = await withTransaction(sellerId, async (client) => {
      const rows = raw.map(normalise);
      // Identity first: a replay answers with the original result; anything that
      // fails below rolls this claim back with the rest of the transaction.
      const uploadId = await claimImport(client, {
        sellerId, sourceId: null, source: 'stock_count', key, contentSha256: contentSha, fileFormat: ext,
        total: rows.length, overlapMode: null,
      });
      if (!uploadId) {
        const replay = await replayOf(client, sellerId, key, contentSha);
        if (replay.status !== 200) throw new InventoryError(replay.status, replay.body);
        return { status: 200, body: replay.body };
      }
      const resolve = await ledger.resolveProducts(client, sellerId,
        rows.map(r => ({ product_name: String(r.product_name ?? r.product ?? '').trim() })));
      const anomalies = [];
      const byProduct = new Map();
      rows.forEach((r, i) => {
        const rowNumber = i + 1;
        const name = String(r.product_name ?? r.product ?? '').trim();
        const rawQty = r.quantity ?? r.counted_quantity ?? r.on_hand ?? r.stock_level;
        if (!name) { anomalies.push({ row_number: rowNumber, product_name: null, field: 'product_name', anomaly_type: 'missing_value', original_value: null }); return; }
        const productId = resolve({ product_name: name });
        if (!productId) { anomalies.push({ row_number: rowNumber, product_name: name, field: 'product_name', anomaly_type: 'product_not_found', original_value: name }); return; }
        if (rawQty === undefined || rawQty === null || String(rawQty).trim() === '') {
          anomalies.push({ row_number: rowNumber, product_name: name, field: 'quantity', anomaly_type: 'missing_value', original_value: null }); return;
        }
        const q = wholeQuantity(rawQty);
        if (q.error) { anomalies.push({ row_number: rowNumber, product_name: name, field: 'quantity', anomaly_type: q.error, original_value: String(rawQty) }); return; }
        if (!byProduct.has(productId)) byProduct.set(productId, { name, rows: [] });
        byProduct.get(productId).rows.push({ rowNumber, quantity: q.value });
      });
      const items = [];
      let duplicateRows = 0;
      for (const [productId, g] of byProduct) {
        const values = new Set(g.rows.map(r => r.quantity));
        if (values.size > 1) {
          for (const r of g.rows) {
            anomalies.push({ row_number: r.rowNumber, product_name: g.name, field: 'quantity', anomaly_type: 'conflicting_duplicate',
              original_value: `${r.quantity} (this file lists ${[...values].join(', ')} for the same product)` });
          }
          continue;
        }
        duplicateRows += g.rows.length - 1;
        items.push({ productId, quantity: g.rows[0].quantity });
      }
      const rejectedRows = anomalies.length;
      if (!items.length) {
        throw new InventoryError(400, { error: 'no_valid_rows', message: 'No row of this file could be recorded. Nothing was imported.',
          rejected_rows: anomalies.slice(0, MAX_REPORTED).map(a => ({ row: a.row_number, product_name: a.product_name, problem: a.anomaly_type, value: a.original_value })) });
      }

      const location = await ledger.ensureDefaultLocation(client, sellerId);
      const counts = await ledger.recordCounts(client, {
        sellerId, userId: sellerId, kind: 'count_file', idempotencyKey: `count-file:${uploadId}`, observedAt: countedAt,
        uploadId, location, items, supersede,
      });
      for (const a of anomalies) {
        await client.query(
          `INSERT INTO anomalies_detected (upload_id, seller_id, product_name, field, anomaly_type, original_value, row_number, severity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'warning')`,
          [uploadId, sellerId, a.product_name, a.field, a.anomaly_type, a.original_value, a.row_number]);
      }
      const version = await addVersion(client, { sellerId, importId: uploadId, added: counts.recorded,
        skipped: counts.already_recorded + duplicateRows, rejected: rejectedRows });
      const summary = {
        message: 'Stock count recorded', kind: 'stock_count', upload_id: uploadId, version_number: version,
        batch_id: counts.batch_id, counted_at: countedAt, total_rows: rows.length, products_counted: items.length,
        recorded: counts.recorded, already_recorded: counts.already_recorded, superseded: counts.superseded,
        identical_duplicate_rows: duplicateRows, rejected: rejectedRows,
        rejected_rows: anomalies.slice(0, MAX_REPORTED).map(a => ({ row: a.row_number, product_name: a.product_name, problem: a.anomaly_type, value: a.original_value })),
        note: 'Products not listed in this file keep their previous counts.',
      };
      await client.query('UPDATE data_uploads SET clean_records = $2, result_summary = $3 WHERE id = $1',
        [uploadId, rows.length - rejectedRows, summary]);
      return { status: 201, body: { ...summary, replayed: false } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    fail(res, err, 'importing the count file');
  } finally {
    cleanup();
  }
});

// ─── POST /api/inventory/movements ───────────────────────────────────────────
// Manual: { idempotency_key, product_id, kind, quantity, effective_at, reason }
//   kind damage | found | customer_return: quantity is the number of units (sign implied);
//   kind correction: quantity is signed (+ adds, − removes). A reason is required
//   except for customer returns.
// Connector: { source_id, events: [{ external_event_id, kind: shipment | customer_return,
//   product_id | product_name, quantity (units), effective_at, order_ref? }] }
// Receipts come only from purchase orders (Stage 1b).
router.post('/movements', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const body = req.body || {};
    const connector = Array.isArray(body.events);
    const result = await withTransaction(sellerId, async (client) => {
      const location = await ledger.ensureDefaultLocation(client, sellerId);
      const errors = [];
      const events = [];
      if (connector) {
        const sourceId = Number(body.source_id);
        const { rows } = await client.query(
          `SELECT m.location_id FROM data_sources ds
           LEFT JOIN inventory_source_mappings m ON m.source_id = ds.id AND m.seller_id = ds.seller_id
           WHERE ds.id = $1 AND ds.seller_id = $2`, [Number.isInteger(sourceId) ? sourceId : -1, sellerId]);
        if (!rows.length) throw new InventoryError(404, { error: 'not_found', message: 'Source not found.' });
        if (rows[0].location_id !== location.id) {
          throw new InventoryError(422, { error: 'source_not_mapped',
            message: 'This source is not mapped to a stock location, so its shipments cannot be applied. Map it in the source settings first.' });
        }
        if (!body.events.length || body.events.length > MAX_EVENTS) {
          throw new InventoryError(400, { error: 'invalid_request', message: `events must hold 1 to ${MAX_EVENTS} events.` });
        }
        const resolve = await ledger.resolveProducts(client, sellerId, body.events.map(e => e || {}));
        body.events.forEach((e, index) => {
          try {
            if (!e || typeof e !== 'object') throw new Error('invalid_event');
            if (!ledger.EVENT_KINDS.includes(e.kind)) throw new Error('invalid_kind');
            if (typeof e.external_event_id !== 'string' || !e.external_event_id.trim() || e.external_event_id.length > 255) throw new Error('missing_event_id');
            const productId = resolve(e);
            if (!productId) throw new Error('product_not_found');
            const q = wholeQuantity(e.quantity, { allowZero: false });
            if (q.error) throw new Error(q.error);
            let effectiveAt;
            try { effectiveAt = parseInstant(e.effective_at, 'effective_at'); } catch { throw new Error('invalid_effective_at'); }
            events.push({ kind: e.kind, quantity: e.kind === 'shipment' ? -q.value : q.value, effectiveAt, productId, sourceId,
              externalEventId: e.external_event_id.trim(), orderRef: typeof e.order_ref === 'string' ? e.order_ref.slice(0, 255) : null });
          } catch (problem) {
            errors.push({ index, external_event_id: e?.external_event_id ?? null, problem: problem.message });
          }
        });
      } else {
        const key = validKey(body.idempotency_key);
        if (!ledger.MANUAL_KINDS.includes(body.kind)) {
          throw new InventoryError(400, { error: 'invalid_request',
            message: `kind must be one of ${ledger.MANUAL_KINDS.join(', ')}. Shipments come from connected sources; receipts from purchase orders.` });
        }
        const productId = Number(body.product_id);
        const { rows } = await client.query('SELECT id FROM products WHERE id = $1 AND user_id = $2',
          [Number.isInteger(productId) ? productId : -1, sellerId]);
        if (!rows.length) throw new InventoryError(404, { error: 'not_found', message: 'Product not found.' });
        const q = wholeQuantity(body.quantity, { allowZero: false, allowNegative: body.kind === 'correction' });
        if (q.error) throw new InventoryError(400, { error: 'invalid_request', message: `quantity: ${q.error.replace(/_/g, ' ')}.` });
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (body.kind !== 'customer_return' && !reason) {
          throw new InventoryError(400, { error: 'invalid_request', message: 'A reason is required for this adjustment.' });
        }
        const effectiveAt = parseInstant(body.effective_at, 'effective_at');
        events.push({ kind: body.kind, quantity: body.kind === 'damage' ? -q.value : q.value, effectiveAt, productId,
          idempotencyKey: `movement:${key}`, reason: reason || null });
      }
      if (errors.length) {
        throw new InventoryError(400, { error: 'invalid_events', message: 'Some events are invalid. Nothing was recorded.',
          errors: errors.slice(0, MAX_REPORTED), error_count: errors.length });
      }
      return ledger.recordMovements(client, { sellerId, userId: sellerId, location, events });
    });
    res.status(result.inserted.length ? 201 : 200).json({
      recorded: result.inserted.length, replayed: result.replayed.length,
      movements: result.inserted, replayed_events: result.replayed,
    });
  } catch (err) { fail(res, err, 'recording the movement'); }
});

// ─── Policies (manual settings; no AI) ───────────────────────────────────────
function parsePolicy(body) {
  const out = {};
  if ('reorder_threshold' in body) {
    if (body.reorder_threshold === null) out.reorder_threshold = null;
    else {
      const q = wholeQuantity(body.reorder_threshold);
      if (q.error) throw new InventoryError(400, { error: 'invalid_request', message: 'reorder_threshold must be a whole number ≥ 0, or null.' });
      out.reorder_threshold = q.value;
    }
  }
  if ('stale_after_days' in body) {
    if (body.stale_after_days === null) out.stale_after_days = null;
    else {
      const n = Number(body.stale_after_days);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        throw new InventoryError(400, { error: 'invalid_request', message: 'stale_after_days must be a whole number from 1 to 365, or null.' });
      }
      out.stale_after_days = n;
    }
  }
  // Stage 2 settings (migration 006). null = use the default (review 7 days, safety stock 0).
  if ('review_period_days' in body) {
    if (body.review_period_days === null) out.review_period_days = null;
    else {
      const n = Number(body.review_period_days);
      if (!Number.isInteger(n) || n < 1 || n > 28) {
        throw new InventoryError(400, { error: 'invalid_request', message: 'review_period_days must be a whole number from 1 to 28, or null.' });
      }
      out.review_period_days = n;
    }
  }
  if ('safety_stock_units' in body) {
    if (body.safety_stock_units === null) out.safety_stock_units = null;
    else {
      const q = wholeQuantity(body.safety_stock_units);
      if (q.error) throw new InventoryError(400, { error: 'invalid_request', message: 'safety_stock_units must be a whole number ≥ 0, or null.' });
      out.safety_stock_units = q.value;
    }
  }
  if (!Object.keys(out).length) {
    throw new InventoryError(400, { error: 'invalid_request', message: 'Send reorder_threshold, stale_after_days, review_period_days and/or safety_stock_units.' });
  }
  return out;
}

const { DEFAULT_REVIEW_DAYS, DEFAULT_SAFETY_STOCK } = require('../lib/replenishment/engine');
const REPLENISHMENT_DEFAULTS = { review_period_days: DEFAULT_REVIEW_DAYS, safety_stock_units: DEFAULT_SAFETY_STOCK };
const POLICY_FIELDS = ['reorder_threshold', 'stale_after_days', 'review_period_days', 'safety_stock_units'];
async function upsertPolicy(client, sellerId, location, productId, changes) {
  const where = productId === null ? 'product_id IS NULL' : 'product_id = $3';
  const params = productId === null ? [sellerId, location.id] : [sellerId, location.id, productId];
  const { rows } = await client.query(
    `SELECT id, ${POLICY_FIELDS.join(', ')} FROM inventory_policies
     WHERE seller_id = $1 AND location_id = $2 AND ${where}`, params);
  const next = Object.fromEntries(POLICY_FIELDS.map(f => [f, rows[0]?.[f] ?? null]));
  Object.assign(next, changes);
  const values = POLICY_FIELDS.map(f => next[f]);
  if (rows.length) {
    await client.query(
      `UPDATE inventory_policies SET reorder_threshold = $2, stale_after_days = $3, review_period_days = $4, safety_stock_units = $5,
         provenance = 'seller', updated_by = $6, updated_at = NOW() WHERE id = $1`,
      [rows[0].id, ...values, sellerId]);
  } else {
    await client.query(
      `INSERT INTO inventory_policies (seller_id, product_id, location_id, reorder_threshold, stale_after_days, review_period_days,
         safety_stock_units, provenance, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seller', $1)`,
      [sellerId, productId, location.id, ...values]);
  }
}

async function policyView(db, sellerId, productId) {
  const location = await readLocation(db, sellerId);
  const pol = await ledger.policies(db, sellerId, location, productId === null ? null : [productId]);
  const stored = async (pid) => (await db.query(
    `SELECT ${POLICY_FIELDS.join(', ')}, provenance, updated_at FROM inventory_policies
     WHERE seller_id = $1 AND location_id = $2 AND ${pid === null ? 'product_id IS NULL' : 'product_id = $3'}`,
    pid === null ? [sellerId, location.id] : [sellerId, location.id, pid])).rows[0] || null;
  const own = await stored(productId);
  const sellerRow = productId === null ? own : await stored(null);
  // Stage 2 settings: product value, else the seller default, else the documented default.
  const resolve = (field, fallback) => (own?.[field] != null ? { value: own[field], source: productId === null ? 'seller_default' : 'product' }
    : sellerRow?.[field] != null ? { value: sellerRow[field], source: 'seller_default' } : { value: fallback, source: 'default' });
  const review = resolve('review_period_days', REPLENISHMENT_DEFAULTS.review_period_days);
  const safety = resolve('safety_stock_units', REPLENISHMENT_DEFAULTS.safety_stock_units);
  return {
    stored: own,
    effective: {
      ...(productId === null ? pol.sellerDefault : pol.forProduct(productId)),
      review_period_days: review.value, review_period_source: review.source,
      safety_stock_units: safety.value, safety_stock_source: safety.source,
    },
    defaults: { stale_after_days: ledger.DEFAULT_STALE_DAYS, reorder_threshold: null, ...REPLENISHMENT_DEFAULTS },
    note: 'The stale tolerance says when a count needs repeating. It is not evidence that stock stays accurate for that long.',
    replenishment_note: 'The review period is how long an order should last after it arrives (until the next review). Safety stock is a number you choose; it is not a calculated protection level.',
  };
}

const ownProduct = async (db, sellerId, raw) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await db.query('SELECT id FROM products WHERE id = $1 AND user_id = $2', [id, sellerId]);
  return rows.length ? id : null;
};

router.get('/policy', authMiddleware, async (req, res) => {
  try { res.json(await policyView(pool, req.user.id, null)); } catch (err) { fail(res, err, 'loading settings'); }
});
router.patch('/policy', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const changes = parsePolicy(req.body || {});
    await withTransaction(sellerId, async (client) => {
      const location = await ledger.ensureDefaultLocation(client, sellerId);
      await upsertPolicy(client, sellerId, location, null, changes);
    });
    res.json(await policyView(pool, sellerId, null));
  } catch (err) { fail(res, err, 'saving settings'); }
});
router.get('/items/:productId/policy', authMiddleware, async (req, res) => {
  try {
    const id = await ownProduct(pool, req.user.id, req.params.productId);
    if (!id) return res.status(404).json({ error: 'not_found', message: 'Product not found.' });
    res.json(await policyView(pool, req.user.id, id));
  } catch (err) { fail(res, err, 'loading settings'); }
});
router.patch('/items/:productId/policy', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const changes = parsePolicy(req.body || {});
    const id = await withTransaction(sellerId, async (client) => {
      const pid = await ownProduct(client, sellerId, req.params.productId);
      if (!pid) throw new InventoryError(404, { error: 'not_found', message: 'Product not found.' });
      const location = await ledger.ensureDefaultLocation(client, sellerId);
      await upsertPolicy(client, sellerId, location, pid, changes);
      return pid;
    });
    res.json(await policyView(pool, sellerId, id));
  } catch (err) { fail(res, err, 'saving settings'); }
});

// ─── Source declarations (what a connected source reports) ───────────────────
async function sourceView(db, sellerId, sourceId) {
  const { rows } = await db.query(
    `SELECT ds.id, ds.kind, ds.provider, ds.display_name, m.location_id, COALESCE(m.reports_physical_on_hand, FALSE) AS reports_physical_on_hand,
            m.shipment_feed_since, m.updated_at
     FROM data_sources ds LEFT JOIN inventory_source_mappings m ON m.source_id = ds.id AND m.seller_id = ds.seller_id
     WHERE ds.id = $1 AND ds.seller_id = $2`, [sourceId, sellerId]);
  return rows[0] || null;
}
router.get('/sources/:sourceId', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.sourceId);
    const view = Number.isInteger(id) ? await sourceView(pool, req.user.id, id) : null;
    if (!view) return res.status(404).json({ error: 'not_found', message: 'Source not found.' });
    res.json(view);
  } catch (err) { fail(res, err, 'loading the source'); }
});
// { reports_physical_on_hand: bool, shipment_feed_since: ISO | null }
router.put('/sources/:sourceId', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const id = Number(req.params.sourceId);
    const body = req.body || {};
    if (typeof body.reports_physical_on_hand !== 'boolean') {
      throw new InventoryError(400, { error: 'invalid_request', message: 'reports_physical_on_hand must be true or false.' });
    }
    const feedSince = body.shipment_feed_since === null || body.shipment_feed_since === undefined
      ? null : parseInstant(body.shipment_feed_since, 'shipment_feed_since');
    await withTransaction(sellerId, async (client) => {
      const view = Number.isInteger(id) ? await sourceView(client, sellerId, id) : null;
      if (!view) throw new InventoryError(404, { error: 'not_found', message: 'Source not found.' });
      const location = await ledger.ensureDefaultLocation(client, sellerId);
      await client.query(
        `INSERT INTO inventory_source_mappings (seller_id, source_id, location_id, reports_physical_on_hand, shipment_feed_since, updated_by)
         VALUES ($1, $2, $3, $4, $5, $1)
         ON CONFLICT (seller_id, source_id) DO UPDATE SET location_id = EXCLUDED.location_id,
           reports_physical_on_hand = EXCLUDED.reports_physical_on_hand, shipment_feed_since = EXCLUDED.shipment_feed_since,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [sellerId, id, location.id, body.reports_physical_on_hand, feedSince]);
    });
    res.json(await sourceView(pool, sellerId, id));
  } catch (err) { fail(res, err, 'saving the source'); }
});

// ─── GET /api/inventory/alerts ───────────────────────────────────────────────
// Overview list (array shape kept). Known stock at or below the threshold, and
// every product whose stock is unknown (risk_level 'unknown', never omitted).
router.get('/alerts', authMiddleware, async (req, res) => {
  try {
    const { items } = await loadItems(pool, req.user.id);
    const rank = { critical: 0, high: 1, medium: 2, unknown: 3 };
    const alerts = [];
    for (const i of items) {
      const t = i.policy.reorder_threshold;
      const base = {
        product_id: i.product_id, product_name: i.name, category: i.category,
        stock_level: i.stock.on_hand, reorder_threshold: t,
        position_type: i.stock.position_type, last_count_at: i.stock.last_count?.observed_at || null,
        movement_tracking: i.stock.movement_tracking, stock_state: i.readiness.stock.state,
      };
      if (!i.stock.known) {
        alerts.push({ ...base, risk_level: 'unknown', recommended_action: 'Record a stock count' });
      } else if (t !== null && i.stock.on_hand <= t) {
        const risk = i.stock.on_hand <= 0 ? 'critical' : i.stock.on_hand <= t / 2 ? 'high' : 'medium';
        alerts.push({ ...base, risk_level: risk,
          recommended_action: i.stock.position_type === 'tracked' ? 'Review and reorder' : 'Recount, then review and reorder' });
      }
    }
    alerts.sort((a, b) => rank[a.risk_level] - rank[b.risk_level] || (a.stock_level ?? 0) - (b.stock_level ?? 0)
      || String(a.product_name).localeCompare(String(b.product_name)));
    res.json(alerts);
  } catch (err) { fail(res, err, 'loading inventory alerts'); }
});

module.exports = router;
