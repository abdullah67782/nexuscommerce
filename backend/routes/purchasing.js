// /api/suppliers, /api/products/:id/suppliers, /api/purchase-orders (Stage 1b).
// The seller always comes from the token; another seller's ids answer 404.
// Every write runs in one transaction under the per-seller advisory lock.
const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { lockSeller, todayIn } = require('../lib/imports');
const P = require('../lib/purchasing');
const SP = require('../lib/supplierPerformance');

const { InventoryError } = P;
const router = express.Router();

const fail = (res, err, what) => {
  if (err instanceof InventoryError) return res.status(err.status).json(err.body);
  if (err.code === '23505' && /suppliers_name_uq/.test(err.constraint || '')) {
    return res.status(409).json({ error: 'duplicate_supplier', message: 'You already have a supplier with this name.' });
  }
  console.error(`Purchasing ${what} error:`, err.message);
  return res.status(500).json({ error: 'server_error', message: `Error ${what}.` });
};

async function tx(sellerId, fn) {
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

async function today(db, sellerId) {
  const { rows } = await db.query('SELECT timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  return todayIn(rows[0]?.timezone || 'Asia/Karachi');
}
const view = async (sellerId, poId) => P.orderView(pool, sellerId, poId, await today(pool, sellerId));
const optText = (v, max, field) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw P.bad(`${field} must be text of at most ${max} characters.`);
  return v.trim();
};

// ── Suppliers ────────────────────────────────────────────────────────────────
async function supplierById(db, sellerId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await db.query('SELECT * FROM suppliers WHERE id = $1 AND seller_id = $2', [id, sellerId]);
  return rows[0] || null;
}

router.get('/suppliers', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.email, s.phone, s.default_currency, s.notes, s.active, s.updated_at,
              (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id AND ps.active)::int AS products,
              (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id AND ps.active AND ps.lead_time_days IS NULL)::int AS missing_lead_time,
              (SELECT COUNT(*) FROM product_suppliers ps WHERE ps.supplier_id = s.id AND ps.active AND ps.unit_cost IS NULL)::int AS missing_cost,
              (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('draft', 'approved', 'ordered', 'partially_received'))::int AS open_orders
       FROM suppliers s WHERE s.seller_id = $1 ORDER BY s.active DESC, lower(s.name)`, [req.user.id]);
    res.json({ suppliers: rows });
  } catch (err) { fail(res, err, 'loading suppliers'); }
});

// Supplier intelligence: delivery performance, timestamp quality, declared lead times, delay scenarios and the
// data-readiness state of learned delivery estimates (lib/supplierPerformance.js). Read-only.
router.get('/suppliers/performance', authMiddleware, async (req, res) => {
  try {
    res.json(await SP.performance(pool, req.user.id));
  } catch (err) { fail(res, err, 'loading supplier performance'); }
});

router.get('/suppliers/:id/performance', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw P.notFound('Supplier');
    const out = await SP.performance(pool, req.user.id, { supplierId: id, withOrders: true });
    if (!out.suppliers.length) throw P.notFound('Supplier');
    res.json({ ...out, supplier: out.suppliers[0], suppliers: undefined });
  } catch (err) { fail(res, err, 'loading supplier performance'); }
});

function supplierFields(body, creating) {
  const out = {};
  if (creating || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 160) throw P.bad('name is required (at most 160 characters).');
    out.name = body.name.trim();
  }
  for (const [f, max] of [['email', 255], ['phone', 60], ['notes', 2000]]) {
    const v = optText(body[f], max, f);
    if (v !== undefined) out[f] = v;
  }
  if (body.default_currency !== undefined) out.default_currency = P.currency(body.default_currency, 'default_currency');
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw P.bad('active must be true or false.');
    out.active = body.active;
  }
  return out;
}

router.post('/suppliers', authMiddleware, async (req, res) => {
  try {
    const f = supplierFields(req.body || {}, true);
    const row = await tx(req.user.id, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO suppliers (seller_id, name, email, phone, default_currency, notes)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'PKR'), $6) RETURNING *`,
        [req.user.id, f.name, f.email ?? null, f.phone ?? null, f.default_currency ?? null, f.notes ?? null]);
      return rows[0];
    });
    res.status(201).json(row);
  } catch (err) { fail(res, err, 'creating the supplier'); }
});

router.get('/suppliers/:id', authMiddleware, async (req, res) => {
  try {
    const s = await supplierById(pool, req.user.id, req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found', message: 'Supplier not found.' });
    const { rows: links } = await pool.query(
      `SELECT ps.*, p.name AS product_name FROM product_suppliers ps JOIN products p ON p.id = ps.product_id
       WHERE ps.supplier_id = $1 AND ps.seller_id = $2 ORDER BY ps.active DESC, lower(p.name)`, [s.id, req.user.id]);
    res.json({ ...s, links: links.map(l => ({ ...l, unit_cost: l.unit_cost === null ? null : Number(l.unit_cost) })) });
  } catch (err) { fail(res, err, 'loading the supplier'); }
});

// Changing the default currency never changes costs already entered (D9).
router.patch('/suppliers/:id', authMiddleware, async (req, res) => {
  try {
    const f = supplierFields(req.body || {}, false);
    if (!Object.keys(f).length) throw P.bad('Nothing to change.');
    const row = await tx(req.user.id, async (c) => {
      const s = await supplierById(c, req.user.id, req.params.id);
      if (!s) throw P.notFound('Supplier');
      const cols = Object.keys(f);
      const { rows } = await c.query(
        `UPDATE suppliers SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [s.id, ...cols.map(k => f[k])]);
      if (f.active === false) {
        await c.query('UPDATE product_suppliers SET is_preferred = FALSE WHERE supplier_id = $1', [s.id]);
      }
      return rows[0];
    });
    res.json(row);
  } catch (err) { fail(res, err, 'saving the supplier'); }
});

// ── Product–supplier terms ───────────────────────────────────────────────────
async function ownedProduct(db, sellerId, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await db.query('SELECT id, name FROM products WHERE id = $1 AND user_id = $2', [id, sellerId]);
  return rows[0] || null;
}

router.get('/products/:id/suppliers', authMiddleware, async (req, res) => {
  try {
    const p = await ownedProduct(pool, req.user.id, req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found', message: 'Product not found.' });
    const { rows } = await pool.query(
      `SELECT ps.*, s.name AS supplier_name, s.active AS supplier_active FROM product_suppliers ps
       JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = $1 AND ps.seller_id = $2
       ORDER BY ps.active DESC, ps.is_preferred DESC, lower(s.name)`, [p.id, req.user.id]);
    res.json({ product: p, links: rows.map(l => ({ ...l, unit_cost: l.unit_cost === null ? null : Number(l.unit_cost) })) });
  } catch (err) { fail(res, err, 'loading supplier terms'); }
});

// { supplier_sku?, unit_cost? (with currency), currency?, lead_time_days?, lead_time_max_days?, min_order_qty?, pack_size?, is_preferred? }
router.put('/products/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const t = {};
    t.supplier_sku = optText(b.supplier_sku, 120, 'supplier_sku') ?? null;
    if (b.unit_cost === undefined || b.unit_cost === null || b.unit_cost === '') {
      t.unit_cost = null;
      t.currency = b.currency ? P.currency(b.currency) : null;
    } else {
      const cost = Number(b.unit_cost);
      if (!Number.isFinite(cost) || cost < 0 || Math.round(cost * 100) !== Number((cost * 100).toFixed(6))) {
        throw P.bad('unit_cost must be a number ≥ 0 with at most 2 decimals.');
      }
      if (!b.currency) throw P.bad('A unit cost needs its currency (it is never assumed).');
      t.unit_cost = cost;
      t.currency = P.currency(b.currency);
    }
    if (b.lead_time_days === undefined || b.lead_time_days === null || b.lead_time_days === '') t.lead_time_days = null;
    else {
      const n = Number(b.lead_time_days);
      if (!Number.isInteger(n) || n < 0 || n > 365) throw P.bad('lead_time_days must be a whole number from 0 to 365.');
      t.lead_time_days = n;
    }
    if (b.lead_time_max_days === undefined || b.lead_time_max_days === null || b.lead_time_max_days === '') t.lead_time_max_days = null;
    else {
      const n = Number(b.lead_time_max_days);
      if (!Number.isInteger(n) || n < 0 || n > 365) throw P.bad('lead_time_max_days must be a whole number from 0 to 365.');
      if (t.lead_time_days === null) throw P.bad('Set the usual lead time before the slowest one.');
      if (n < t.lead_time_days) throw P.bad('lead_time_max_days (slowest delivery) cannot be shorter than lead_time_days.');
      t.lead_time_max_days = n;
    }
    for (const f of ['min_order_qty', 'pack_size']) {
      if (b[f] === undefined || b[f] === null || b[f] === '') { t[f] = 1; continue; }
      const n = Number(b[f]);
      if (!Number.isInteger(n) || n < 1) throw P.bad(`${f} must be a whole number of at least 1.`);
      t[f] = n;
    }
    t.is_preferred = b.is_preferred === true;
    const row = await tx(req.user.id, async (c) => {
      const p = await ownedProduct(c, req.user.id, req.params.id);
      const s = await supplierById(c, req.user.id, req.params.supplierId);
      if (!p) throw P.notFound('Product');
      if (!s) throw P.notFound('Supplier');
      if (!s.active) throw new InventoryError(409, { error: 'supplier_inactive', message: 'This supplier is inactive. Reactivate it first.' });
      if (t.is_preferred) {
        await c.query('UPDATE product_suppliers SET is_preferred = FALSE WHERE seller_id = $1 AND product_id = $2 AND supplier_id <> $3',
          [req.user.id, p.id, s.id]);
      }
      const { rows } = await c.query(
        `INSERT INTO product_suppliers (seller_id, product_id, supplier_id, supplier_sku, unit_cost, currency, lead_time_days,
           min_order_qty, pack_size, is_preferred, active, updated_by, lead_time_max_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $1, $11)
         ON CONFLICT (seller_id, product_id, supplier_id) DO UPDATE SET supplier_sku = EXCLUDED.supplier_sku,
           unit_cost = EXCLUDED.unit_cost, currency = EXCLUDED.currency, lead_time_days = EXCLUDED.lead_time_days,
           lead_time_max_days = EXCLUDED.lead_time_max_days,
           min_order_qty = EXCLUDED.min_order_qty, pack_size = EXCLUDED.pack_size, is_preferred = EXCLUDED.is_preferred,
           active = TRUE, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING *`,
        [req.user.id, p.id, s.id, t.supplier_sku, t.unit_cost, t.currency, t.lead_time_days, t.min_order_qty, t.pack_size, t.is_preferred,
          t.lead_time_max_days]);
      return rows[0];
    });
    res.json({ ...row, unit_cost: row.unit_cost === null ? null : Number(row.unit_cost),
      note: 'Existing purchase orders keep the terms they were drafted with.' });
  } catch (err) { fail(res, err, 'saving supplier terms'); }
});

// Deactivates the link; existing orders keep their copied terms.
router.delete('/products/:id/suppliers/:supplierId', authMiddleware, async (req, res) => {
  try {
    const out = await tx(req.user.id, async (c) => {
      const p = await ownedProduct(c, req.user.id, req.params.id);
      const s = await supplierById(c, req.user.id, req.params.supplierId);
      if (!p || !s) throw P.notFound('Supplier terms');
      const { rowCount } = await c.query(
        `UPDATE product_suppliers SET active = FALSE, is_preferred = FALSE, updated_by = $3, updated_at = NOW()
         WHERE product_id = $1 AND supplier_id = $2`, [p.id, s.id, req.user.id]);
      if (!rowCount) throw P.notFound('Supplier terms');
      return { deactivated: true };
    });
    res.json(out);
  } catch (err) { fail(res, err, 'removing supplier terms'); }
});

// ── Purchase orders ──────────────────────────────────────────────────────────
const STATUSES = ['draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled'];

router.get('/purchase-orders', authMiddleware, async (req, res) => {
  try {
    const status = req.query.status || null;
    if (status && !STATUSES.includes(status) && status !== 'open') {
      return res.status(400).json({ error: 'invalid_request', message: `status must be one of ${STATUSES.join(', ')} or open.` });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 25));
    const day = await today(pool, req.user.id);
    const where = status === 'open' ? `po.status IN ('draft', 'approved', 'ordered', 'partially_received')`
      : status ? 'po.status = $2' : 'TRUE';
    const params = status && status !== 'open' ? [req.user.id, status] : [req.user.id];
    const { rows } = await pool.query(
      `SELECT po.id, po.status, po.version, po.currency, po.supplier_id, s.name AS supplier_name,
              to_char(po.expected_arrival, 'YYYY-MM-DD') AS expected_arrival, po.created_at, po.ordered_at, po.completed_at, po.cancelled_at,
              COUNT(q.line_id)::int AS lines, COALESCE(SUM(q.quantity_ordered), 0)::int AS ordered,
              COALESCE(SUM(q.quantity_received), 0)::int AS received, COALESCE(SUM(q.quantity_remaining), 0)::int AS remaining,
              COALESCE(SUM(q.quantity_returned), 0)::int AS returned
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN purchase_order_line_quantities q ON q.po_id = po.id
       WHERE po.seller_id = $1 AND ${where}
       GROUP BY po.id, s.name ORDER BY po.id DESC`, params);
    const counts = { all: rows.length };
    for (const s of STATUSES) counts[s] = rows.filter(r => r.status === s).length;
    const list = rows.map(r => ({ ...r,
      overdue: P.OPEN_STATUSES.includes(r.status) && r.remaining > 0 && r.expected_arrival !== null && r.expected_arrival < day }));
    res.json({ purchase_orders: list.slice((page - 1) * pageSize, page * pageSize), page, page_size: pageSize, total: list.length,
      counts, today: day });
  } catch (err) { fail(res, err, 'loading purchase orders'); }
});

router.get('/purchase-orders/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const v = Number.isInteger(id) && id > 0 ? await view(req.user.id, id) : null;
    if (!v) return res.status(404).json({ error: 'not_found', message: 'Purchase order not found.' });
    res.set('ETag', `"${v.version}"`).json(v);
  } catch (err) { fail(res, err, 'loading the purchase order'); }
});

const respond = async (res, sellerId, poId, status = 200, extra = {}) => {
  const v = await view(sellerId, poId);
  res.status(status).set('ETag', `"${v.version}"`).json({ purchase_order: v, stock_effects: [], ...extra });
};

// Draft: { idempotency_key, supplier_id, currency?, expected_arrival?, notes?, lines: [{ product_id, quantity }] }
router.post('/purchase-orders', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const b = req.body || {};
    const k = P.key(b.idempotency_key);
    const expected = b.expected_arrival === undefined ? null : P.businessDay(b.expected_arrival, 'expected_arrival');
    const notes = optText(b.notes, 2000, 'notes') ?? null;
    const out = await tx(sellerId, async (c) => {
      const s = await supplierById(c, sellerId, b.supplier_id);
      if (!s) throw P.notFound('Supplier');
      const currency = b.currency ? P.currency(b.currency) : s.default_currency;
      const content = P.sha({ supplier: s.id, currency, expected, notes,
        lines: (Array.isArray(b.lines) ? b.lines : []).map(l => [Number(l?.product_id), l?.quantity]).sort((x, y) => x[0] - y[0]) });
      const { rows: prior } = await c.query('SELECT id, content_sha256 FROM purchase_orders WHERE seller_id = $1 AND idempotency_key = $2',
        [sellerId, k]);
      if (prior.length) {
        if (prior[0].content_sha256 !== content) {
          throw new InventoryError(409, { error: 'idempotency_conflict', message: 'This request id was already used for a different order.' });
        }
        return { id: prior[0].id, replayed: true };
      }
      if (!s.active) throw new InventoryError(409, { error: 'supplier_inactive', message: 'This supplier is inactive.' });
      const lines = await P.validateLines(c, sellerId, s.id, b.lines);
      const location = await P.ensureDefaultLocation(c, sellerId);
      const { rows } = await c.query(
        `INSERT INTO purchase_orders (seller_id, supplier_id, location_id, currency, idempotency_key, content_sha256,
           expected_arrival, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1) RETURNING id`,
        [sellerId, s.id, location.id, currency, k, content, expected, notes]);
      await P.insertLines(c, sellerId, rows[0].id, lines);
      await P.addEvent(c, { sellerId, poId: rows[0].id, event: 'created', to: 'draft', actor: sellerId,
        detail: { lines: lines.map(l => ({ product_id: l.productId, quantity: l.quantity })), currency, expected_arrival: expected } });
      return { id: rows[0].id, replayed: false };
    });
    await respond(res, sellerId, out.id, out.replayed ? 200 : 201, { replayed: out.replayed });
  } catch (err) { fail(res, err, 'creating the purchase order'); }
});

// Edit: draft → anything; approved / ordered / partially_received → expected_arrival only.
router.patch('/purchase-orders/:id', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const b = req.body || {};
    const version = P.expectedVersion(req);
    await tx(sellerId, async (c) => {
      let po = await P.lockedOrder(c, sellerId, req.params.id);
      P.checkVersion(po, version);
      const draftOnly = ['supplier_id', 'currency', 'notes', 'lines'].filter(f => b[f] !== undefined);
      if (draftOnly.length && po.status !== 'draft') {
        throw new InventoryError(409, { error: 'not_editable',
          message: `Only a draft can change ${draftOnly.join(', ')}. This order is ${po.status.replace('_', ' ')}; it is never edited as a draft. Cancel it and create a new order if needed.` });
      }
      if (b.expected_arrival !== undefined && ['received', 'cancelled'].includes(po.status)) {
        throw new InventoryError(409, { error: 'not_editable', message: `A ${po.status} order has no arrival to change.` });
      }
      if (!draftOnly.length && b.expected_arrival === undefined) throw P.bad('Nothing to change.');
      const fields = {};
      const changed = {};
      if (b.expected_arrival !== undefined) {
        const next = P.businessDay(b.expected_arrival, 'expected_arrival');
        const prev = po.expected_arrival ? P.fmtDate(po.expected_arrival) : null;
        if (next !== prev) {
          fields.expected_arrival = next;
          await P.addEvent(c, { sellerId, poId: po.id, event: 'expected_arrival_changed', from: po.status, to: po.status, actor: sellerId,
            detail: { from: prev, to: next, reason: optText(b.reason, 500, 'reason') ?? null } });
        }
      }
      if (po.status === 'draft') {
        let supplierId = po.supplier_id;
        if (b.supplier_id !== undefined && Number(b.supplier_id) !== po.supplier_id) {
          const s = await supplierById(c, sellerId, b.supplier_id);
          if (!s) throw P.notFound('Supplier');
          if (!s.active) throw new InventoryError(409, { error: 'supplier_inactive', message: 'This supplier is inactive.' });
          supplierId = s.id; fields.supplier_id = s.id; changed.supplier_id = s.id;
        }
        if (b.currency !== undefined) { fields.currency = P.currency(b.currency); changed.currency = fields.currency; }
        if (b.notes !== undefined) { fields.notes = optText(b.notes, 2000, 'notes'); changed.notes = true; }
        if (b.lines !== undefined || fields.supplier_id) {
          // Lines are re-validated and their terms re-copied from the (new) supplier's links.
          const raw = b.lines !== undefined ? b.lines
            : (await P.lineQuantities(c, po.id)).map(l => ({ product_id: l.product_id, quantity: l.quantity_ordered }));
          const lines = await P.validateLines(c, sellerId, supplierId, raw);
          await c.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [po.id]);
          // Reset the cost acknowledgement: it applied to the previous lines.
          fields.unknown_costs_accepted = false;
          await P.insertLines(c, sellerId, po.id, lines);
          changed.lines = lines.map(l => ({ product_id: l.productId, quantity: l.quantity }));
        }
      }
      po = await P.updateOrder(c, po, fields);
      if (Object.keys(changed).length) {
        await P.addEvent(c, { sellerId, poId: po.id, event: 'edited', from: 'draft', to: 'draft', actor: sellerId, detail: changed });
      }
    });
    await respond(res, sellerId, Number(req.params.id));
  } catch (err) { fail(res, err, 'editing the purchase order'); }
});

// Approve: checks lines, links, one currency, pack size and minimum order (D5), costs.
router.post('/purchase-orders/:id/approve', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const version = P.expectedVersion(req);
    await tx(sellerId, async (c) => {
      const po = await P.lockedOrder(c, sellerId, req.params.id);
      P.checkVersion(po, version);
      if (po.status !== 'draft') throw transitionRefused(po.status, 'approve');
      const { rows: s } = await c.query('SELECT active FROM suppliers WHERE id = $1', [po.supplier_id]);
      if (!s[0].active) throw new InventoryError(409, { error: 'supplier_inactive', message: 'This supplier is inactive.' });
      const lines = await P.lineQuantities(c, po.id);
      if (!lines.length) throw new InventoryError(422, { error: 'approval_refused', message: 'An order needs at least one line.', problems: [] });
      const terms = await P.linkTerms(c, sellerId, po.supplier_id, lines.map(l => l.product_id));
      const problems = [];
      for (const l of lines) {
        const t = terms.get(l.product_id);
        if (!t || !t.active) problems.push({ line_id: l.line_id, product_id: l.product_id, problem: 'no_supplier_link', detail: `${l.product_name} is no longer linked to this supplier.` });
        for (const p of P.lineProblems(l.quantity_ordered, l)) problems.push({ line_id: l.line_id, product_id: l.product_id, ...p, detail: `${l.product_name}: ${p.detail}` });
        if (l.unit_cost !== null && l.cost_currency !== po.currency) {
          problems.push({ line_id: l.line_id, product_id: l.product_id, problem: 'currency_mismatch',
            detail: `${l.product_name} costs are in ${l.cost_currency}; this order is in ${po.currency}. One currency per order; costs are never converted.` });
        }
      }
      const unknown = lines.filter(l => l.unit_cost === null);
      if (unknown.length && req.body?.accept_unknown_costs !== true) {
        problems.push(...unknown.map(l => ({ line_id: l.line_id, product_id: l.product_id, problem: 'unknown_cost',
          detail: `${l.product_name} has no unit cost. Set it, or approve with costs explicitly marked unknown.` })));
      }
      if (problems.length) {
        throw new InventoryError(422, { error: 'approval_refused', message: 'The order cannot be approved yet. Nothing was changed.', problems });
      }
      await P.updateOrder(c, po, { status: 'approved', approved_at: new Date(), approved_by: sellerId,
        unknown_costs_accepted: unknown.length > 0 });
      await P.addEvent(c, { sellerId, poId: po.id, event: 'approved', from: 'draft', to: 'approved', actor: sellerId,
        detail: { unknown_costs_accepted: unknown.length > 0, note: 'Approval does not change stock.' } });
    });
    await respond(res, sellerId, Number(req.params.id));
  } catch (err) { fail(res, err, 'approving the purchase order'); }
});

function transitionRefused(status, action) {
  return new InventoryError(409, { error: 'invalid_transition',
    message: `A ${status.replace('_', ' ')} order cannot be ${action === 'approve' ? 'approved' : action === 'order' ? 'marked as ordered' : 'cancelled'}.`,
    status });
}

// { version, ordered_at? }
router.post('/purchase-orders/:id/mark-ordered', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const version = P.expectedVersion(req);
    const orderedAt = req.body?.ordered_at ? P.parseInstant(req.body.ordered_at, 'ordered_at') : new Date().toISOString();
    await tx(sellerId, async (c) => {
      const po = await P.lockedOrder(c, sellerId, req.params.id);
      P.checkVersion(po, version);
      if (po.status !== 'approved') throw transitionRefused(po.status, 'order');
      await P.updateOrder(c, po, { status: 'ordered', ordered_at: orderedAt });
      await P.addEvent(c, { sellerId, poId: po.id, event: 'ordered', from: 'approved', to: 'ordered', actor: sellerId,
        detail: { ordered_at: orderedAt, expected_arrival: po.expected_arrival ? P.fmtDate(po.expected_arrival) : null,
          note: 'Ordered quantities are incoming, not on-hand.' } });
    });
    await respond(res, sellerId, Number(req.params.id));
  } catch (err) { fail(res, err, 'marking the order as ordered'); }
});

// Cancel closes the remainder only: received goods stay, and the order never reopens.
router.post('/purchase-orders/:id/cancel', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const version = P.expectedVersion(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw P.bad('A reason is required to cancel an order.');
    await tx(sellerId, async (c) => {
      const po = await P.lockedOrder(c, sellerId, req.params.id);
      P.checkVersion(po, version);
      if (!['draft', 'approved', 'ordered', 'partially_received'].includes(po.status)) throw transitionRefused(po.status, 'cancel');
      const lines = await P.lineQuantities(c, po.id);
      const closed = [];
      for (const l of lines) {
        if (l.quantity_remaining > 0) {
          await c.query('UPDATE purchase_order_lines SET quantity_cancelled = quantity_cancelled + $2 WHERE id = $1', [l.line_id, l.quantity_remaining]);
          closed.push({ line_id: l.line_id, product_id: l.product_id, quantity_cancelled: l.quantity_remaining });
        }
      }
      await P.updateOrder(c, po, { status: 'cancelled', cancelled_at: new Date(), cancelled_by: sellerId, cancel_reason: reason });
      await P.addEvent(c, { sellerId, poId: po.id, event: 'cancelled', from: po.status, to: 'cancelled', actor: sellerId,
        detail: { reason, closed, received_kept: lines.reduce((s, l) => s + l.quantity_received, 0) } });
    });
    await respond(res, sellerId, Number(req.params.id));
  } catch (err) { fail(res, err, 'cancelling the purchase order'); }
});

// Receive: { idempotency_key, received_at, note?, lines: [{ line_id, quantity }] }
// One 'receipt' movement per line. A replay returns the original result and never adds stock twice.
router.post('/purchase-orders/:id/receipts', authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  try {
    const b = req.body || {};
    const k = P.key(b.idempotency_key);
    const receivedAt = P.parseInstant(b.received_at, 'received_at');
    const note = optText(b.note, 1000, 'note') ?? null;
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200) throw P.bad('lines must list 1 to 200 order lines.');
    const content = P.sha({ po: Number(req.params.id), receivedAt, note,
      lines: b.lines.map(l => [Number(l?.line_id), l?.quantity]).sort((x, y) => x[0] - y[0]) });
    const out = await tx(sellerId, async (c) => {
      let po = await P.lockedOrder(c, sellerId, req.params.id);
      const { rows: prior } = await c.query('SELECT id, po_id, received_at, content_sha256 FROM purchase_receipts WHERE seller_id = $1 AND idempotency_key = $2',
        [sellerId, k]);
      if (prior.length) {
        if (prior[0].content_sha256 !== content || prior[0].po_id !== po.id) {
          throw new InventoryError(409, { error: 'idempotency_conflict', message: 'This receipt id was already used for different goods. Nothing was recorded.' });
        }
        // Replay: the original receipt and its movements, rebuilt from the ledger. Nothing is written.
        const { rows: eff } = await c.query(
          `SELECT l.product_id, p.name AS product_name, m.id AS movement_id, m.quantity, m.effective_at
           FROM purchase_receipt_lines rl JOIN purchase_order_lines l ON l.id = rl.po_line_id JOIN products p ON p.id = l.product_id
           JOIN stock_movements m ON m.receipt_line_id = rl.id WHERE rl.receipt_id = $1 ORDER BY rl.id`, [prior[0].id]);
        return { receipt_id: prior[0].id, purchase_order_id: po.id, received_at: new Date(prior[0].received_at).toISOString(),
          stock_effects: eff.map(e => ({ ...e, kind: 'receipt', effective_at: new Date(e.effective_at).toISOString() })), replayed: true };
      }
      if (b.version !== undefined) P.checkVersion(po, versionNumber(b.version));
      if (!P.OPEN_STATUSES.includes(po.status)) {
        throw new InventoryError(409, { error: 'not_receivable',
          message: po.status === 'cancelled' ? 'A cancelled order cannot receive goods; it never reopens. Create a new order.'
            : po.status === 'received' ? 'Everything on this order is already received.'
              : 'Goods can be received only after the order is marked as ordered.' });
      }
      const lines = await P.lineQuantities(c, po.id);
      const byId = new Map(lines.map(l => [l.line_id, l]));
      const errors = [];
      const seen = new Set();
      const plan = [];
      b.lines.forEach((l, index) => {
        const line = byId.get(Number(l?.line_id));
        if (!line) { errors.push({ index, problem: 'line_not_found' }); return; }
        if (seen.has(line.line_id)) { errors.push({ index, line_id: line.line_id, problem: 'duplicate_line' }); return; }
        seen.add(line.line_id);
        const q = wholeOrError(l.quantity);
        if (q.error) { errors.push({ index, line_id: line.line_id, problem: q.error }); return; }
        if (q.value > line.quantity_remaining) {
          errors.push({ index, line_id: line.line_id, product_id: line.product_id, problem: 'over_receipt',
            detail: `${line.product_name}: ${q.value} received but only ${line.quantity_remaining} remain on the order.` });
          return;
        }
        plan.push({ line, quantity: q.value });
      });
      if (errors.length) {
        const over = errors.some(e => e.problem === 'over_receipt');
        throw new InventoryError(over ? 409 : 400, { error: over ? 'over_receipt' : 'invalid_lines',
          message: over ? 'More than the remaining quantity cannot be received (amend with a new order). Nothing was recorded.'
            : 'Some lines are invalid. Nothing was recorded.', errors });
      }
      const { rows: [r] } = await c.query(
        `INSERT INTO purchase_receipts (seller_id, po_id, received_at, recorded_by, idempotency_key, content_sha256, note)
         VALUES ($1, $2, $3, $1, $4, $5, $6) RETURNING id`, [sellerId, po.id, receivedAt, k, content, note]);
      const effects = [];
      for (const p of plan) {
        const { rows: [rl] } = await c.query(
          'INSERT INTO purchase_receipt_lines (seller_id, receipt_id, po_line_id, quantity) VALUES ($1, $2, $3, $4) RETURNING id',
          [sellerId, r.id, p.line.line_id, p.quantity]);
        const { rows: [m] } = await c.query(
          `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key,
             content_sha256, created_by, receipt_line_id, order_ref)
           VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7, $1, $8, $9) RETURNING id`,
          [sellerId, p.line.product_id, po.location_id, p.quantity, receivedAt, `po-receipt-line:${rl.id}`,
            P.sha({ receipt_line: rl.id, quantity: p.quantity }), rl.id, `PO-${po.id}`]);
        effects.push({ product_id: p.line.product_id, product_name: p.line.product_name, movement_id: m.id, kind: 'receipt',
          quantity: p.quantity, effective_at: receivedAt });
      }
      await P.addEvent(c, { sellerId, poId: po.id, event: 'received_goods', from: po.status, to: po.status, actor: sellerId,
        detail: { receipt_id: r.id, received_at: receivedAt, stock_effects: effects } });
      po = await P.refreshReceivingStatus(c, po, sellerId, `receipt ${r.id}`);
      return { receipt_id: r.id, purchase_order_id: po.id, received_at: receivedAt, stock_effects: effects, replayed: false };
    });
    await respond(res, sellerId, out.purchase_order_id, out.replayed ? 200 : 201,
      { stock_effects: out.stock_effects, receipt_id: out.receipt_id, replayed: out.replayed });
  } catch (err) { fail(res, err, 'recording the receipt'); }
});

function versionNumber(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw P.bad('version must be a positive whole number.');
  return n;
}

function wholeOrError(v) {
  return P.wholeQuantity(v, { allowZero: false });
}

// Corrections and supplier returns share one implementation (§10).
async function adjustReceipt(req, res, kind) {
  const sellerId = req.user.id;
  try {
    const b = req.body || {};
    const k = P.key(b.idempotency_key);
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reason) throw P.bad('A reason is required.');
    const returnedAt = kind === 'supplier_return' ? P.parseInstant(b.returned_at, 'returned_at') : null;
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200) throw P.bad('lines must list 1 to 200 receipt lines.');
    const requestSha = P.sha({ kind, po: Number(req.params.id), receipt: Number(req.params.receiptId), reason, returnedAt,
      lines: b.lines.map(l => [Number(l?.receipt_line_id), l?.quantity]).sort((x, y) => x[0] - y[0]) });
    const out = await tx(sellerId, async (c) => {
      let po = await P.lockedOrder(c, sellerId, req.params.id);
      const { rows: prior } = await c.query(
        `SELECT a.id, a.request_sha256, a.receipt_line_id, a.quantity, a.kind, m.id AS movement_id, m.quantity AS movement_quantity,
                m.effective_at, l.product_id
         FROM purchase_receipt_adjustments a
         JOIN purchase_receipt_lines rl ON rl.id = a.receipt_line_id JOIN purchase_order_lines l ON l.id = rl.po_line_id
         LEFT JOIN stock_movements m ON m.receipt_adjustment_id = a.id
         WHERE a.seller_id = $1 AND a.request_key = $2`, [sellerId, k]);
      if (prior.length) {
        if (prior.some(p => p.request_sha256 !== requestSha)) {
          throw new InventoryError(409, { error: 'idempotency_conflict', message: 'This request id was already used for a different change. Nothing was recorded.' });
        }
        return { replayed: true, stock_effects: prior.map(p => ({ product_id: p.product_id, movement_id: p.movement_id,
          kind: p.kind === 'correction' ? 'receipt_correction' : 'supplier_return', quantity: p.movement_quantity,
          effective_at: new Date(p.effective_at).toISOString() })) };
      }
      // Checked after the replay test: a valid replay returns the original result
      // and never advances the version again, whatever version it carries.
      if (b.version !== undefined) P.checkVersion(po, versionNumber(b.version));
      const receiptId = Number(req.params.receiptId);
      const { rows: rec } = await c.query('SELECT id, received_at FROM purchase_receipts WHERE id = $1 AND po_id = $2 AND seller_id = $3',
        [Number.isInteger(receiptId) ? receiptId : -1, po.id, sellerId]);
      if (!rec.length) throw P.notFound('Receipt');
      const receipt = rec[0];
      if (returnedAt && new Date(returnedAt) < new Date(receipt.received_at)) {
        throw P.bad('Goods cannot be returned before they were received.');
      }
      const { rows: rlines } = await c.query(
        `SELECT rl.id, rl.quantity, l.product_id, p.name AS product_name,
                COALESCE((SELECT SUM(a.quantity) FROM purchase_receipt_adjustments a WHERE a.receipt_line_id = rl.id), 0)::int AS adjusted
         FROM purchase_receipt_lines rl JOIN purchase_order_lines l ON l.id = rl.po_line_id JOIN products p ON p.id = l.product_id
         WHERE rl.receipt_id = $1`, [receipt.id]);
      const byId = new Map(rlines.map(l => [l.id, l]));
      const errors = [];
      const seen = new Set();
      const plan = [];
      b.lines.forEach((l, index) => {
        const line = byId.get(Number(l?.receipt_line_id));
        if (!line) { errors.push({ index, problem: 'receipt_line_not_found' }); return; }
        if (seen.has(line.id)) { errors.push({ index, receipt_line_id: line.id, problem: 'duplicate_line' }); return; }
        seen.add(line.id);
        const q = wholeOrError(l.quantity);
        if (q.error) { errors.push({ index, receipt_line_id: line.id, problem: q.error }); return; }
        const left = line.quantity - line.adjusted;
        if (q.value > left) {
          errors.push({ index, receipt_line_id: line.id, product_id: line.product_id, problem: 'exceeds_received',
            detail: `${line.product_name}: only ${left} of the ${line.quantity} received on this receipt can still be ${kind === 'correction' ? 'corrected' : 'returned'} (corrections and returns together never exceed the receipt).` });
          return;
        }
        plan.push({ line, quantity: q.value });
      });
      if (errors.length) {
        const over = errors.some(e => e.problem === 'exceeds_received');
        throw new InventoryError(over ? 409 : 400, { error: over ? 'exceeds_received' : 'invalid_lines',
          message: over ? 'That is more than this receipt can still give back. Nothing was recorded.' : 'Some lines are invalid. Nothing was recorded.', errors });
      }
      const effectiveAt = kind === 'correction' ? new Date(receipt.received_at).toISOString() : returnedAt;
      const movementKind = kind === 'correction' ? 'receipt_correction' : 'supplier_return';
      const effects = [];
      for (const p of plan) {
        const { rows: [a] } = await c.query(
          `INSERT INTO purchase_receipt_adjustments (seller_id, receipt_line_id, kind, quantity, effective_at, reason, request_key,
             request_sha256, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1) RETURNING id`,
          [sellerId, p.line.id, kind, p.quantity, effectiveAt, reason, k, requestSha]);
        const { rows: [m] } = await c.query(
          `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, idempotency_key,
             content_sha256, reason, created_by, receipt_adjustment_id, order_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, $10, $11) RETURNING id`,
          [sellerId, p.line.product_id, po.location_id, movementKind, -p.quantity, effectiveAt, `po-adjustment:${a.id}`,
            P.sha({ adjustment: a.id, quantity: -p.quantity }), reason, a.id, `PO-${po.id}`]);
        effects.push({ product_id: p.line.product_id, product_name: p.line.product_name, movement_id: m.id, kind: movementKind,
          quantity: -p.quantity, effective_at: effectiveAt });
      }
      await P.addEvent(c, { sellerId, poId: po.id, event: kind === 'correction' ? 'receipt_corrected' : 'goods_returned',
        from: po.status, to: po.status, actor: sellerId,
        detail: { receipt_id: receipt.id, reason, stock_effects: effects,
          note: kind === 'correction'
            ? 'Effective at the receipt time: a later physical count stays authoritative.'
            : 'Goods left the location at the return time; the received quantity is unchanged.' } });
      // Every new adjustment advances the order version exactly once — including a
      // correction on a cancelled or otherwise unchanged order, whose status refresh
      // does not touch the row.
      const before = po.version;
      if (kind === 'correction') po = await P.refreshReceivingStatus(c, po, sellerId, `receipt ${receipt.id} corrected`);
      if (po.version === before) po = await P.updateOrder(c, po, {});
      return { replayed: false, stock_effects: effects };
    });
    await respond(res, sellerId, Number(req.params.id), out.replayed ? 200 : 201, out);
  } catch (err) { fail(res, err, kind === 'correction' ? 'correcting the receipt' : 'recording the return'); }
}

router.post('/purchase-orders/:id/receipts/:receiptId/corrections', authMiddleware, (req, res) => adjustReceipt(req, res, 'correction'));
router.post('/purchase-orders/:id/receipts/:receiptId/returns', authMiddleware, (req, res) => adjustReceipt(req, res, 'supplier_return'));

module.exports = router;
