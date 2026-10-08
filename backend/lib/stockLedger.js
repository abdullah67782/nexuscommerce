// Inventory ledger (migration 004): counts, movements and the derived position.
//
// Accounting contract (docs/inventory-stage1-plan.md, architect review 1a):
//   * A COUNT is an absolute physical measurement of one product at one location
//     at an instant. It INCLUDES every event effective at or before that instant
//     (equal timestamps: the event is inside the count).
//   * A MOVEMENT is a signed physical delta with its own identity. Movements are
//     append-only; whether one falls before or after "the" count is decided at
//     read time against the currently selected count, never stored.
//   * Selected count = the active, VERIFIED count with the latest measurement
//     instant. Unverified legacy values (no measurement time) are shown but never
//     outrank a verified count and never become an arithmetic baseline.
//     Two active counts for the same product/location/instant cannot exist; a
//     different value at the same instant needs explicit supersession.
//   * on_hand = selected count + Σ movements effective strictly after it.
//     No selected count → on_hand is unknown (null), never zero.
//   * on_hand is physical stock at the location. Reservations are not tracked,
//     so it is NOT available-to-sell stock.
//   * Movement-tracking completeness is reported separately from count age:
//     'complete' only when a source declared to send every shipment for the
//     location since before the count exists and no other source recorded sales
//     on or after the count date; otherwise 'partial', or 'absent' with no feed.
const crypto = require('node:crypto');
const { stableStringify, lockSeller } = require('./imports');

const DEFAULT_STALE_DAYS = 7;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MANUAL_KINDS = ['damage', 'customer_return', 'found', 'correction'];
const EVENT_KINDS = ['shipment', 'customer_return'];
const NEGATIVE_KINDS = ['shipment', 'damage'];

class InventoryError extends Error {
  constructor(status, body) {
    super(body.message || body.error);
    this.status = status;
    this.body = body;
  }
}

const sha = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
const bad = (message, extra = {}) => { throw new InventoryError(400, { error: 'invalid_request', message, ...extra }); };

// An instant must carry its own offset (or Z) so ordering against counts is
// established; local or date-only values are refused rather than guessed.
function parseInstant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
    bad(`${field} must be a full timestamp with a timezone offset, e.g. 2026-10-08T18:30:00+05:00.`);
  }
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) bad(`${field} is not a valid timestamp.`);
  if (d.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) bad(`${field} is in the future.`);
  return d.toISOString();
}

function wholeQuantity(value, { allowZero = true, allowNegative = false, field = 'quantity' } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'invalid_quantity' };
  if (!Number.isInteger(n)) return { error: 'fractional_quantity' };
  if (n < 0 && !allowNegative) return { error: 'negative_value' };
  if (n === 0 && !allowZero) return { error: 'zero_quantity' };
  return { value: n, field };
}

async function ensureDefaultLocation(db, sellerId) {
  await db.query(
    `INSERT INTO inventory_locations (seller_id) VALUES ($1)
     ON CONFLICT (seller_id) WHERE is_default DO NOTHING`, [sellerId]);
  const { rows } = await db.query(
    'SELECT id, name, timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  return rows[0];
}

async function resolveProducts(db, sellerId, items) {
  // items: [{ product_id?, product_name? }] → product ids owned by the seller (or null).
  const ids = [...new Set(items.filter(i => i.product_id !== undefined && i.product_id !== null).map(i => Number(i.product_id)))];
  const names = [...new Set(items.filter(i => typeof i.product_name === 'string').map(i => i.product_name.trim()))];
  const byId = new Map();
  const byName = new Map();
  if (ids.length) {
    const { rows } = await db.query('SELECT id FROM products WHERE user_id = $1 AND id = ANY($2::int[])', [sellerId, ids.filter(Number.isInteger)]);
    rows.forEach(r => byId.set(r.id, r.id));
  }
  if (names.length) {
    const { rows } = await db.query(
      'SELECT DISTINCT ON (name) id, name FROM products WHERE user_id = $1 AND name = ANY($2) ORDER BY name, id', [sellerId, names]);
    rows.forEach(r => byName.set(r.name, r.id));
  }
  return (item) => (item.product_id !== undefined && item.product_id !== null
    ? byId.get(Number(item.product_id)) ?? null
    : byName.get(String(item.product_name || '').trim()) ?? null);
}

// ── Counts ───────────────────────────────────────────────────────────────────
// items: [{ productId, quantity, row? }] (already validated, one per product).
// Same idempotency key + same content → original result (replayed). Different
// content → 409. An identical value already recorded at the same instant is not
// a new observation; a different value there needs supersede = true.
async function recordCounts(client, { sellerId, userId, kind, idempotencyKey, observedAt, sourceId = null,
  uploadId = null, location, items, supersede = false, extraSummary = {} }) {
  const content = sha({ kind, observedAt, sourceId, locationId: location.id, supersede,
    items: [...items].sort((a, b) => a.productId - b.productId).map(i => [i.productId, i.quantity]) });
  const claim = await client.query(
    `INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, source_id, upload_id,
       location_id, observed_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (seller_id, idempotency_key) DO NOTHING RETURNING id`,
    [sellerId, idempotencyKey, content, kind, sourceId, uploadId, location.id, observedAt, userId]);
  if (!claim.rows.length) {
    const { rows } = await client.query(
      'SELECT id, content_sha256, status, result_summary FROM stock_snapshot_batches WHERE seller_id = $1 AND idempotency_key = $2',
      [sellerId, idempotencyKey]);
    if (rows[0].content_sha256 !== content) {
      throw new InventoryError(409, { error: 'idempotency_conflict',
        message: 'This submission id was already used for different counts. Use a new id for a new count.' });
    }
    return { ...rows[0].result_summary, replayed: true, revoked: rows[0].status === 'revoked' };
  }
  const batchId = claim.rows[0].id;

  const { rows: existing } = await client.query(
    `SELECT id, product_id, quantity, batch_id FROM stock_snapshots
     WHERE seller_id = $1 AND location_id = $2 AND observed_at = $3 AND status = 'active' AND product_id = ANY($4::int[])`,
    [sellerId, location.id, observedAt, items.map(i => i.productId)]);
  const atInstant = new Map(existing.map(e => [e.product_id, e]));
  const conflicts = [];
  const toInsert = [];
  const already = [];
  for (const item of items) {
    const prior = atInstant.get(item.productId);
    if (!prior) { toInsert.push({ ...item }); continue; }
    if (prior.quantity === item.quantity) { already.push(item.productId); continue; }
    if (!supersede) {
      conflicts.push({ product_id: item.productId, observed_at: observedAt, recorded_quantity: prior.quantity,
        new_quantity: item.quantity, recorded_in_batch: prior.batch_id });
      continue;
    }
    toInsert.push({ ...item, supersedes: prior.id });
  }
  if (conflicts.length) {
    throw new InventoryError(409, { error: 'conflicting_count',
      message: 'A different count is already recorded for the same product at the same instant. Nothing was recorded. '
        + 'Re-submit with supersede = true to replace it explicitly.',
      conflicts: conflicts.slice(0, 50), conflict_count: conflicts.length });
  }
  const superseded = [];
  for (const item of toInsert) {
    const { rows } = await client.query("SELECT nextval(pg_get_serial_sequence('stock_snapshots', 'id')) AS id");
    const id = Number(rows[0].id);
    if (item.supersedes) {
      await client.query("UPDATE stock_snapshots SET status = 'superseded', superseded_by = $2 WHERE id = $1",
        [item.supersedes, id]);
      superseded.push(item.supersedes);
    }
    await client.query(
      `INSERT INTO stock_snapshots (id, seller_id, batch_id, product_id, location_id, quantity, observed_at, verification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified')`,
      [id, sellerId, batchId, item.productId, location.id, item.quantity, observedAt]);
  }
  const summary = { batch_id: batchId, observed_at: observedAt, location_id: location.id, recorded: toInsert.length,
    already_recorded: already.length, superseded: superseded.length, ...extraSummary };
  await client.query('UPDATE stock_snapshot_batches SET result_summary = $2 WHERE id = $1', [batchId, summary]);
  return { ...summary, replayed: false };
}

// Revoke a whole submission (count-file rollback, or the seller revoking a count).
// Counts it had superseded become active again: undoing a submission restores
// the state before it. Nothing is deleted.
async function revokeBatch(client, { sellerId, userId, batchId, reason }) {
  const { rows } = await client.query(
    `UPDATE stock_snapshot_batches SET status = 'revoked', revoked_at = NOW(), revoked_by = $3, revoke_reason = $4
     WHERE id = $1 AND seller_id = $2 AND status = 'active' AND source_kind <> 'legacy_migration' RETURNING id`,
    [batchId, sellerId, userId, reason]);
  if (!rows.length) return 0;
  const { rows: own } = await client.query(
    "SELECT id, status, superseded_by FROM stock_snapshots WHERE batch_id = $1 AND status <> 'revoked'", [batchId]);
  // 1. Revoke every snapshot of the batch first (frees the one-active-per-instant slot).
  await client.query(
    "UPDATE stock_snapshots SET status = 'revoked', superseded_by = NULL WHERE batch_id = $1 AND status <> 'revoked'", [batchId]);
  for (const s of own) {
    if (s.status === 'superseded') {
      // A later count already replaced this one: what it had replaced now points
      // to that later count and stays superseded.
      await client.query('UPDATE stock_snapshots SET superseded_by = $2 WHERE superseded_by = $1', [s.id, s.superseded_by]);
    } else {
      // It was the active count: the count it replaced becomes active again.
      await client.query(
        "UPDATE stock_snapshots SET status = 'active', superseded_by = NULL WHERE superseded_by = $1 AND status = 'superseded'", [s.id]);
    }
  }
  return own.length;
}

// ── Movements ────────────────────────────────────────────────────────────────
// events: normalised { kind, quantity (signed), effectiveAt, productId, sourceId,
// externalEventId, idempotencyKey, orderRef, reason }. Replay of an identical
// event is a no-op; same identity with different content refuses the request.
async function recordMovements(client, { sellerId, userId, location, events }) {
  const result = { inserted: [], replayed: [] };
  const conflicts = [];
  const plan = [];
  for (const e of events) {
    const content = sha({ kind: e.kind, quantity: e.quantity, effectiveAt: e.effectiveAt, productId: e.productId,
      locationId: location.id, orderRef: e.orderRef || null, reason: e.reason || null });
    const { rows } = e.externalEventId
      ? await client.query(
        'SELECT id, content_sha256 FROM stock_movements WHERE seller_id = $1 AND source_id = $2 AND external_event_id = $3',
        [sellerId, e.sourceId, e.externalEventId])
      : await client.query(
        'SELECT id, content_sha256 FROM stock_movements WHERE seller_id = $1 AND idempotency_key = $2',
        [sellerId, e.idempotencyKey]);
    const identity = e.externalEventId ? { external_event_id: e.externalEventId } : { idempotency_key: e.idempotencyKey };
    if (rows.length) {
      if (rows[0].content_sha256 === content) result.replayed.push({ ...identity, movement_id: rows[0].id });
      else conflicts.push({ ...identity, movement_id: rows[0].id });
      continue;
    }
    if (plan.some(p => (e.externalEventId ? p.externalEventId === e.externalEventId : p.idempotencyKey === e.idempotencyKey))) {
      conflicts.push({ ...identity, movement_id: null, within_request: true });
      continue;
    }
    plan.push({ ...e, content });
  }
  if (conflicts.length) {
    throw new InventoryError(409, { error: 'event_conflict',
      message: 'Some event ids were already recorded with different contents. Nothing was recorded.',
      conflicts: conflicts.slice(0, 50), conflict_count: conflicts.length });
  }
  for (const e of plan) {
    const { rows } = await client.query(
      `INSERT INTO stock_movements (seller_id, product_id, location_id, kind, quantity, effective_at, source_id,
         external_event_id, order_ref, idempotency_key, content_sha256, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [sellerId, e.productId, location.id, e.kind, e.quantity, e.effectiveAt, e.sourceId || null,
        e.externalEventId || null, e.orderRef || null, e.idempotencyKey || null, e.content, e.reason || null, userId]);
    result.inserted.push({ movement_id: rows[0].id, product_id: e.productId, kind: e.kind, quantity: e.quantity,
      ...(e.externalEventId ? { external_event_id: e.externalEventId } : { idempotency_key: e.idempotencyKey }) });
  }
  return result;
}

// ── Positions ────────────────────────────────────────────────────────────────
// Returns Map(product_id → position) for the seller's products at a location.
async function positions(db, sellerId, location, productIds = null) {
  const { rows } = await db.query(
    `WITH prods AS (
       SELECT id FROM products WHERE user_id = $1 AND ($3::int[] IS NULL OR id = ANY($3::int[]))
     ),
     base AS (
       SELECT DISTINCT ON (s.product_id) s.product_id, s.id AS snapshot_id, s.quantity, s.observed_at,
              b.source_kind, b.source_id, b.id AS batch_id
       FROM stock_snapshots s JOIN stock_snapshot_batches b ON b.id = s.batch_id
       WHERE s.seller_id = $1 AND s.location_id = $2 AND s.status = 'active' AND s.verification = 'verified'
         AND s.product_id IN (SELECT id FROM prods)
       ORDER BY s.product_id, s.observed_at DESC
     ),
     legacy AS (
       SELECT DISTINCT ON (product_id) product_id, quantity, legacy_recorded_at
       FROM stock_snapshots
       WHERE seller_id = $1 AND location_id = $2 AND status = 'active' AND verification = 'unverified'
         AND product_id IN (SELECT id FROM prods)
       ORDER BY product_id, id DESC
     ),
     mv AS (
       SELECT m.product_id,
              COUNT(*)::int AS events_total,
              COALESCE(SUM(m.quantity) FILTER (WHERE base.observed_at IS NOT NULL AND m.effective_at > base.observed_at), 0)::int AS delta_after,
              COUNT(*) FILTER (WHERE base.observed_at IS NOT NULL AND m.effective_at > base.observed_at)::int AS events_after,
              COUNT(*) FILTER (WHERE base.observed_at IS NOT NULL AND m.effective_at <= base.observed_at)::int AS events_included,
              -- An event at exactly the count's instant is inside the count. Only the same
              -- connector that reported the count establishes that ordering itself.
              COUNT(*) FILTER (WHERE m.effective_at = base.observed_at
                               AND NOT (base.source_id IS NOT NULL AND m.source_id = base.source_id))::int AS same_instant_other_source,
              MAX(m.effective_at) AS last_event_at
       FROM stock_movements m LEFT JOIN base ON base.product_id = m.product_id
       WHERE m.seller_id = $1 AND m.location_id = $2 AND m.product_id IN (SELECT id FROM prods)
       GROUP BY m.product_id
     )
     SELECT p.id AS product_id, base.snapshot_id, base.quantity AS count_quantity, base.observed_at, base.source_kind,
            base.source_id AS count_source_id, base.batch_id,
            legacy.quantity AS legacy_quantity,
            -- a naive write time from the old table: returned as written, never as an instant
            to_char(legacy.legacy_recorded_at, 'YYYY-MM-DD HH24:MI') AS legacy_recorded_at,
            COALESCE(mv.events_total, 0) AS events_total, COALESCE(mv.delta_after, 0) AS delta_after,
            COALESCE(mv.events_after, 0) AS events_after, COALESCE(mv.events_included, 0) AS events_included,
            COALESCE(mv.same_instant_other_source, 0) AS same_instant_other_source, mv.last_event_at,
            to_char((base.observed_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS count_business_date
     FROM prods p
     LEFT JOIN base ON base.product_id = p.id
     LEFT JOIN legacy ON legacy.product_id = p.id
     LEFT JOIN mv ON mv.product_id = p.id`,
    [sellerId, location.id, productIds, location.timezone]);

  // Movement-tracking completeness (separate from count age).
  const { rows: feeds } = await db.query(
    `SELECT source_id, shipment_feed_since FROM inventory_source_mappings
     WHERE seller_id = $1 AND location_id = $2 AND shipment_feed_since IS NOT NULL`, [sellerId, location.id]);
  const feedIds = feeds.map(f => f.source_id);
  const counted = rows.filter(r => r.snapshot_id);
  const untrackedSales = new Map();
  if (counted.length && feeds.length) {
    const { rows: sales } = await db.query(
      `SELECT a.product_id, COUNT(*)::int AS n
       FROM attributed_sales a
       JOIN unnest($2::int[], $3::date[]) AS c(product_id, count_date) ON c.product_id = a.product_id
       WHERE a.seller_id = $1 AND a.sale_date >= c.count_date
         AND (a.source_id IS NULL OR NOT (a.source_id = ANY($4::int[])))
       GROUP BY a.product_id`,
      [sellerId, counted.map(r => r.product_id), counted.map(r => r.count_business_date), feedIds]);
    sales.forEach(s => untrackedSales.set(s.product_id, s.n));
  }

  const now = Date.now();
  const out = new Map();
  for (const r of rows) {
    const has = Boolean(r.snapshot_id);
    let tracking = 'not_applicable';
    if (has) {
      const observed = new Date(r.observed_at).getTime();
      const covering = feeds.filter(f => new Date(f.shipment_feed_since).getTime() <= observed);
      if (!feeds.length) tracking = 'absent';
      else if (covering.length && !untrackedSales.get(r.product_id)) tracking = 'complete';
      else tracking = 'partial';
    }
    out.set(r.product_id, {
      product_id: r.product_id,
      known: has,
      on_hand: has ? r.count_quantity + r.delta_after : null,
      basis: has ? (tracking === 'complete' ? 'tracked_position' : 'last_known_count') : null,
      last_count: has ? {
        snapshot_id: r.snapshot_id, batch_id: r.batch_id, quantity: r.count_quantity,
        observed_at: new Date(r.observed_at).toISOString(), business_date: r.count_business_date,
        age_days: Math.floor((now - new Date(r.observed_at).getTime()) / 86400000), source_kind: r.source_kind,
      } : null,
      movement_tracking: tracking,
      events_since_count: has ? r.events_after : 0,
      net_change_since_count: has ? r.delta_after : 0,
      events_included_in_count: has ? r.events_included : 0,
      events_without_count: has ? 0 : r.events_total,
      same_instant_events: r.same_instant_other_source,
      untracked_sales_since_count: untrackedSales.get(r.product_id) || 0,
      legacy: r.legacy_quantity === null || r.legacy_quantity === undefined ? null : {
        quantity: r.legacy_quantity, written_at_server_time: r.legacy_recorded_at, verification: 'unverified',
      },
    });
  }
  return out;
}

// ── Policies ─────────────────────────────────────────────────────────────────
async function policies(db, sellerId, location, productIds = null) {
  const { rows } = await db.query(
    `SELECT product_id, reorder_threshold, stale_after_days, provenance, updated_at FROM inventory_policies
     WHERE seller_id = $1 AND location_id = $2 AND (product_id IS NULL OR $3::int[] IS NULL OR product_id = ANY($3::int[]))`,
    [sellerId, location.id, productIds]);
  const seller = rows.find(r => r.product_id === null) || null;
  const byProduct = new Map(rows.filter(r => r.product_id !== null).map(r => [r.product_id, r]));
  const sellerStale = seller?.stale_after_days ?? DEFAULT_STALE_DAYS;
  return {
    sellerDefault: { stale_after_days: sellerStale, reorder_threshold: seller?.reorder_threshold ?? null },
    forProduct(productId) {
      const p = byProduct.get(productId);
      return {
        reorder_threshold: p?.reorder_threshold ?? seller?.reorder_threshold ?? null,
        stale_after_days: p?.stale_after_days ?? sellerStale,
        provenance: p ? p.provenance : seller ? 'seller_default' : 'default',
        threshold_source: p?.reorder_threshold !== null && p?.reorder_threshold !== undefined
          ? p.provenance : seller?.reorder_threshold !== null && seller?.reorder_threshold !== undefined ? 'seller_default' : null,
      };
    },
  };
}

module.exports = {
  InventoryError, DEFAULT_STALE_DAYS, MANUAL_KINDS, EVENT_KINDS, NEGATIVE_KINDS,
  parseInstant, wholeQuantity, ensureDefaultLocation, resolveProducts,
  recordCounts, revokeBatch, recordMovements, positions, policies, lockSeller, sha,
};
