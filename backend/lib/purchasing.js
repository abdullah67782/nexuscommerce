// Suppliers and purchasing (Stage 1b). Accounting rules: migrations/005 header
// and docs/inventory-stage1-plan.md §3.2 and §10.
//   * Approval and ordering never change stock; a receipt writes one 'receipt'
//     movement per receipt line, effective at received_at.
//   * Correction (recorded wrongly): 'receipt_correction' −qty at the RECEIPT's
//     instant, so a later count stays authoritative; reduces quantity received.
//   * Supplier return (goods sent back): 'supplier_return' −qty at the return time;
//     received quantity unchanged.
//   * Corrections + returns of a receipt line ≤ that line's quantity.
//   * A cancelled order never reopens; its remaining stays 0.
//   * Every order change bumps `version` (optimistic concurrency) and appends a
//     durable event. All writes run under the per-seller advisory lock.
const { InventoryError, sha, parseInstant, wholeQuantity, ensureDefaultLocation } = require('./stockLedger');
const { isDay } = require('./coverage');

const CURRENCY = /^[A-Z]{3}$/;
const OPEN_STATUSES = ['ordered', 'partially_received'];
const MAX_LINES = 200;

const bad = (message, extra = {}) => new InventoryError(400, { error: 'invalid_request', message, ...extra });
const notFound = (what) => new InventoryError(404, { error: 'not_found', message: `${what} not found.` });

function currency(value, field = 'currency') {
  if (typeof value !== 'string' || !CURRENCY.test(value.trim().toUpperCase())) {
    throw bad(`${field} must be a 3-letter ISO currency code, e.g. PKR.`);
  }
  return value.trim().toUpperCase();
}

function businessDay(value, field) {
  if (value === null) return null;
  if (!isDay(value)) throw bad(`${field} must be a date written YYYY-MM-DD.`);
  return value;
}

function key(value, field = 'idempotency_key') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw bad(`${field} must be a non-empty string of at most 200 characters.`);
  }
  return value.trim();
}

// If-Match header ("3", W/"3") or body.version.
function expectedVersion(req) {
  const raw = req.get('If-Match') ?? req.body?.version;
  if (raw === undefined || raw === null || raw === '') {
    throw new InventoryError(428, { error: 'version_required',
      message: 'Send the order version you are changing (If-Match header or "version"), so concurrent changes are not overwritten.' });
  }
  const n = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw bad('version must be a positive whole number.');
  return n;
}

async function addEvent(client, { sellerId, poId, event, from = null, to = null, detail = {}, actor }) {
  await client.query(
    `INSERT INTO purchase_order_events (seller_id, po_id, event, from_status, to_status, detail, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [sellerId, poId, event, from, to, detail, actor]);
}

async function lockedOrder(client, sellerId, poId) {
  const id = Number(poId);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Purchase order');
  const { rows } = await client.query('SELECT * FROM purchase_orders WHERE id = $1 AND seller_id = $2 FOR UPDATE', [id, sellerId]);
  if (!rows.length) throw notFound('Purchase order');
  return rows[0];
}

function checkVersion(po, expected) {
  if (po.version !== expected) {
    throw new InventoryError(409, { error: 'version_conflict',
      message: `This order was changed by someone else (now version ${po.version}, you sent ${expected}). Reload it and try again.`,
      current_version: po.version });
  }
}

// Bump the version and set fields in one statement; the WHERE on version makes
// a lost update impossible even without the seller lock.
async function updateOrder(client, po, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  const { rows } = await client.query(
    `UPDATE purchase_orders SET ${['version = version + 1', ...sets].join(', ')}
     WHERE id = $1 AND version = $2 RETURNING *`, [po.id, po.version, ...cols.map(c => fields[c])]);
  if (!rows.length) checkVersion({ version: -1 }, po.version);
  return rows[0];
}

async function lineQuantities(db, poId) {
  const { rows } = await db.query(
    `SELECT q.*, l.unit_cost, l.cost_currency, l.pack_size, l.min_order_qty, p.name AS product_name
     FROM purchase_order_line_quantities q
     JOIN purchase_order_lines l ON l.id = q.line_id
     JOIN products p ON p.id = q.product_id
     WHERE q.po_id = $1 ORDER BY q.line_id`, [poId]);
  return rows;
}

// Terms from the active product–supplier links (snapshots copied onto lines).
async function linkTerms(db, sellerId, supplierId, productIds) {
  const { rows } = await db.query(
    `SELECT ps.product_id, ps.unit_cost, ps.currency, ps.pack_size, ps.min_order_qty, ps.lead_time_days, ps.active
     FROM product_suppliers ps
     WHERE ps.seller_id = $1 AND ps.supplier_id = $2 AND ps.product_id = ANY($3::int[])`,
    [sellerId, supplierId, productIds]);
  return new Map(rows.map(r => [r.product_id, r]));
}

// Pack-size / minimum-order problems (D5). No rounding: the seller decides.
function lineProblems(quantity, terms) {
  const out = [];
  if (quantity < terms.min_order_qty) out.push({ problem: 'below_minimum_order', detail: `Minimum order is ${terms.min_order_qty}.` });
  if (quantity % terms.pack_size !== 0) {
    const lower = Math.floor(quantity / terms.pack_size) * terms.pack_size;
    out.push({ problem: 'not_a_pack_multiple',
      detail: `Packs of ${terms.pack_size}: order ${lower || terms.pack_size} or ${lower + terms.pack_size}.` });
  }
  return out;
}

async function validateLines(client, sellerId, supplierId, rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length || rawLines.length > MAX_LINES) {
    throw bad(`lines must list 1 to ${MAX_LINES} products.`);
  }
  const ids = rawLines.map(l => Number(l?.product_id));
  const { rows: owned } = await client.query('SELECT id, name FROM products WHERE user_id = $1 AND id = ANY($2::int[])',
    [sellerId, ids.filter(Number.isInteger)]);
  const names = new Map(owned.map(r => [r.id, r.name]));
  const terms = await linkTerms(client, sellerId, supplierId, [...names.keys()]);
  const errors = [];
  const seen = new Set();
  const lines = [];
  rawLines.forEach((l, index) => {
    const productId = Number(l?.product_id);
    if (!names.has(productId)) { errors.push({ index, problem: 'product_not_found' }); return; }
    if (seen.has(productId)) { errors.push({ index, product_id: productId, problem: 'duplicate_product' }); return; }
    seen.add(productId);
    const q = wholeQuantity(l.quantity, { allowZero: false });
    if (q.error) { errors.push({ index, product_id: productId, problem: q.error }); return; }
    const t = terms.get(productId);
    if (!t || !t.active) {
      errors.push({ index, product_id: productId, problem: 'no_supplier_link',
        detail: `${names.get(productId)} has no active terms with this supplier. Add them on the Suppliers tab first.` });
      return;
    }
    lines.push({ productId, quantity: q.value, terms: t, name: names.get(productId) });
  });
  if (errors.length) {
    throw new InventoryError(400, { error: 'invalid_lines', message: 'Some lines are invalid. Nothing was saved.', errors });
  }
  return lines;
}

async function insertLines(client, sellerId, poId, lines) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO purchase_order_lines (seller_id, po_id, product_id, quantity_ordered, unit_cost, cost_currency, pack_size, min_order_qty)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sellerId, poId, l.productId, l.quantity, l.terms.unit_cost, l.terms.unit_cost === null ? null : l.terms.currency,
        l.terms.pack_size, l.terms.min_order_qty]);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────
async function orderView(db, sellerId, poId, todayDate) {
  const { rows } = await db.query(
    `SELECT po.*, s.name AS supplier_name, s.active AS supplier_active
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = $1 AND po.seller_id = $2`, [poId, sellerId]);
  if (!rows.length) return null;
  const po = rows[0];
  const lines = await lineQuantities(db, po.id);
  const { rows: receipts } = await db.query(
    `SELECT r.id, r.received_at, r.recorded_at, r.note, r.idempotency_key,
            COALESCE(json_agg(json_build_object(
              'receipt_line_id', rl.id, 'po_line_id', rl.po_line_id, 'product_id', l.product_id, 'quantity', rl.quantity,
              'movement_id', m.id,
              'corrected', COALESCE((SELECT SUM(a.quantity) FROM purchase_receipt_adjustments a WHERE a.receipt_line_id = rl.id AND a.kind = 'correction'), 0),
              'returned', COALESCE((SELECT SUM(a.quantity) FROM purchase_receipt_adjustments a WHERE a.receipt_line_id = rl.id AND a.kind = 'supplier_return'), 0)
            ) ORDER BY rl.id), '[]') AS lines
     FROM purchase_receipts r
     JOIN purchase_receipt_lines rl ON rl.receipt_id = r.id
     JOIN purchase_order_lines l ON l.id = rl.po_line_id
     LEFT JOIN stock_movements m ON m.receipt_line_id = rl.id
     WHERE r.po_id = $1 GROUP BY r.id ORDER BY r.received_at, r.id`, [po.id]);
  const { rows: adjustments } = await db.query(
    `SELECT a.id, a.kind, a.quantity, a.effective_at, a.reason, a.recorded_at, rl.receipt_id, a.receipt_line_id,
            l.product_id, m.id AS movement_id
     FROM purchase_receipt_adjustments a
     JOIN purchase_receipt_lines rl ON rl.id = a.receipt_line_id
     JOIN purchase_order_lines l ON l.id = rl.po_line_id
     LEFT JOIN stock_movements m ON m.receipt_adjustment_id = a.id
     WHERE l.po_id = $1 ORDER BY a.id`, [po.id]);
  const { rows: events } = await db.query(
    `SELECT id, event, from_status, to_status, detail, actor, at FROM purchase_order_events WHERE po_id = $1 ORDER BY id`, [po.id]);

  const remaining = lines.reduce((s, l) => s + l.quantity_remaining, 0);
  const costKnown = lines.every(l => l.unit_cost !== null);
  const total = costKnown ? lines.reduce((s, l) => s + Number(l.unit_cost) * l.quantity_ordered, 0) : null;
  const open = OPEN_STATUSES.includes(po.status);
  return {
    id: po.id, status: po.status, version: po.version, currency: po.currency,
    supplier: { id: po.supplier_id, name: po.supplier_name, active: po.supplier_active },
    location_id: po.location_id, expected_arrival: po.expected_arrival ? fmtDate(po.expected_arrival) : null,
    overdue: open && remaining > 0 && po.expected_arrival !== null && todayDate && fmtDate(po.expected_arrival) < todayDate,
    notes: po.notes, unknown_costs_accepted: po.unknown_costs_accepted,
    created_at: po.created_at, approved_at: po.approved_at, ordered_at: po.ordered_at,
    first_receipt_at: po.first_receipt_at, completed_at: po.completed_at,
    cancelled_at: po.cancelled_at, cancel_reason: po.cancel_reason,
    totals: {
      ordered: lines.reduce((s, l) => s + l.quantity_ordered, 0),
      received: lines.reduce((s, l) => s + l.quantity_received, 0),
      returned: lines.reduce((s, l) => s + l.quantity_returned, 0),
      cancelled: lines.reduce((s, l) => s + l.quantity_cancelled, 0),
      remaining,
      inbound: open ? remaining : 0,
      cost: total === null ? null : Number(total.toFixed(2)),
      cost_complete: costKnown,
    },
    lines: lines.map(l => ({
      id: l.line_id, product_id: l.product_id, product_name: l.product_name,
      quantity_ordered: l.quantity_ordered, quantity_received: l.quantity_received,
      quantity_received_gross: l.quantity_received_gross, quantity_corrected: l.quantity_corrected,
      quantity_returned: l.quantity_returned, quantity_cancelled: l.quantity_cancelled,
      quantity_remaining: l.quantity_remaining,
      unit_cost: l.unit_cost === null ? null : Number(l.unit_cost), cost_currency: l.cost_currency,
      pack_size: l.pack_size, min_order_qty: l.min_order_qty,
      problems: lineProblems(l.quantity_ordered, l),
    })),
    receipts, adjustments, events,
  };
}

function fmtDate(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Incoming stock per product, separate from on-hand.
async function inboundByProduct(db, sellerId, productIds, todayDate) {
  const { rows } = await db.query(
    `SELECT q.product_id,
            COALESCE(SUM(q.quantity_remaining) FILTER (WHERE q.status IN ('ordered', 'partially_received')), 0)::int AS open_quantity,
            COALESCE(SUM(q.quantity_remaining) FILTER (WHERE q.status = 'approved'), 0)::int AS approved_not_sent,
            COUNT(DISTINCT q.po_id) FILTER (WHERE q.status IN ('ordered', 'partially_received') AND q.quantity_remaining > 0)::int AS open_orders,
            to_char(MIN(po.expected_arrival) FILTER (WHERE q.status IN ('ordered', 'partially_received') AND q.quantity_remaining > 0), 'YYYY-MM-DD') AS next_expected,
            COALESCE(SUM(q.quantity_remaining) FILTER (WHERE q.status IN ('ordered', 'partially_received') AND q.quantity_remaining > 0
                                                         AND po.expected_arrival < $3::date), 0)::int AS overdue_quantity,
            COALESCE(SUM(q.quantity_remaining) FILTER (WHERE q.status IN ('ordered', 'partially_received') AND q.quantity_remaining > 0
                                                         AND po.expected_arrival IS NULL), 0)::int AS no_date_quantity
     FROM purchase_order_line_quantities q JOIN purchase_orders po ON po.id = q.po_id
     WHERE q.seller_id = $1 AND ($2::int[] IS NULL OR q.product_id = ANY($2::int[]))
     GROUP BY q.product_id`, [sellerId, productIds, todayDate]);
  return new Map(rows.map(r => [r.product_id, r]));
}

async function supplierTermsByProduct(db, sellerId, productIds) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (ps.product_id) ps.product_id, ps.supplier_id, s.name AS supplier_name, ps.is_preferred,
            ps.unit_cost, ps.currency, ps.lead_time_days, ps.pack_size, ps.min_order_qty,
            COUNT(*) OVER (PARTITION BY ps.product_id)::int AS active_links
     FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
     WHERE ps.seller_id = $1 AND ps.active AND s.active AND ($2::int[] IS NULL OR ps.product_id = ANY($2::int[]))
     ORDER BY ps.product_id, ps.is_preferred DESC, ps.id`, [sellerId, productIds]);
  return new Map(rows.map(r => [r.product_id, r]));
}

function inboundDimension(inb) {
  if (!inb || (inb.open_quantity === 0 && inb.approved_not_sent === 0)) {
    return { state: 'none', reason: 'No open purchase order for this product.', action: null };
  }
  if (inb.overdue_quantity > 0) {
    return { state: 'overdue', reason: `${inb.overdue_quantity} unit(s) are past their promised arrival date and not received.`, action: 'Check with the supplier, then update the expected arrival.' };
  }
  if (inb.open_quantity === 0) {
    return { state: 'approved_not_sent', reason: `${inb.approved_not_sent} unit(s) are approved but the order is not placed yet.`, action: 'Mark the order as ordered once it is sent.' };
  }
  if (inb.no_date_quantity > 0) {
    return { state: 'no_expected_date', reason: `${inb.no_date_quantity} incoming unit(s) have no expected arrival date.`, action: 'Add the supplier\'s promised arrival date.' };
  }
  return { state: 'open', reason: `${inb.open_quantity} unit(s) incoming, next expected ${inb.next_expected}. Not counted in on-hand until received.`, action: null };
}

function supplierDimension(t) {
  if (!t) return { state: 'none', reason: 'No supplier is linked to this product.', action: 'Link a supplier on the Suppliers tab.' };
  if (t.lead_time_days === null) return { state: 'missing_lead_time', reason: `Lead time not set for ${t.supplier_name}.`, action: 'Set the lead time.' };
  if (t.unit_cost === null) return { state: 'missing_cost', reason: `Unit cost not set for ${t.supplier_name}.`, action: 'Set the unit cost and currency.' };
  return { state: 'complete', reason: `${t.supplier_name}: ${t.lead_time_days} day(s) lead time, ${t.currency} ${Number(t.unit_cost).toFixed(2)} per unit.`, action: null };
}

// ── Receipt status after receipts or corrections ─────────────────────────────
async function refreshReceivingStatus(client, po, actor, cause) {
  if (!['ordered', 'partially_received', 'received'].includes(po.status)) return po;
  const lines = await lineQuantities(client, po.id);
  const remaining = lines.reduce((s, l) => s + l.quantity_remaining, 0);
  const received = lines.reduce((s, l) => s + l.quantity_received, 0);
  const next = remaining === 0 ? 'received' : received > 0 ? 'partially_received' : 'ordered';
  const { rows: [first] } = await client.query('SELECT MIN(received_at) AS t FROM purchase_receipts WHERE po_id = $1', [po.id]);
  const fields = { first_receipt_at: first.t };
  if (next !== po.status) {
    fields.status = next;
    fields.completed_at = next === 'received' ? new Date() : null;
  }
  const updated = await updateOrder(client, po, fields);
  if (next !== po.status) {
    await addEvent(client, { sellerId: po.seller_id, poId: po.id, event: 'status_changed', from: po.status, to: next,
      detail: { cause }, actor });
  }
  return updated;
}

module.exports = {
  CURRENCY, OPEN_STATUSES, currency, businessDay, key, expectedVersion, addEvent, lockedOrder, checkVersion,
  updateOrder, lineQuantities, linkTerms, lineProblems, validateLines, insertLines, orderView, inboundByProduct,
  supplierTermsByProduct, inboundDimension, supplierDimension, refreshReceivingStatus, fmtDate,
  InventoryError, sha, parseInstant, wholeQuantity, ensureDefaultLocation, notFound, bad,
};
