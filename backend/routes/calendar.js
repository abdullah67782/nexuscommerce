// Store calendar API (Inventory Stage 3a), mounted at /api/calendar.
//
//   GET   /settings                      confirmed country, suggestion from the location timezone, supported catalogs
//   PUT   /settings                      { country_code } — the seller confirms the country (a timezone is not proof)
//   GET   /?from&to[&include_cancelled]  holidays (expected / scheduled / confirmed) and the seller's entries
//   POST  /holidays/confirm              { event_key, year, start, end?, note? } — local date of a holiday (append-only)
//   POST  /entries                       promotion | closure | supplier_delay | demand_scenario
//   PATCH /entries/:id                   change (If-Match or "version"), recorded as an event
//   POST  /entries/:id/cancel            cancel (If-Match or "version"); history is kept
//   GET   /entries/:id/history           the entry's append-only events
//
// Every write runs under the seller's advisory lock: the calendar is a replenishment input, and the
// draft-creation revalidation relies on every input writer taking that lock. Another seller's ids answer 404.
'use strict';

const express = require('express');
const pool = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { lockSeller, todayIn, defaultTimezone } = require('../lib/imports');
const { InventoryError } = require('../lib/stockLedger');
const C = require('../lib/calendar');

const router = express.Router();
const KINDS = ['promotion', 'closure', 'supplier_delay', 'demand_scenario'];
const SCOPES = ['all', 'category', 'products', 'supplier'];

const fail = (res, err, what) => {
  if (err instanceof InventoryError) return res.status(err.status).json(err.body);
  if (err.code === '23514') return res.status(400).json({ error: 'invalid_request', message: 'The calendar entry breaks a rule of its kind.' });
  console.error(`Calendar ${what} error:`, err.message);
  return res.status(500).json({ error: 'server_error', message: `Error ${what}.` });
};
const notFound = (what = 'Calendar entry') => new InventoryError(404, { error: 'not_found', message: `${what} not found.` });
const ownId = (raw) => { const id = Number(raw); return Number.isInteger(id) && id > 0 ? id : null; };

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

async function location(db, sellerId) {
  const { rows } = await db.query('SELECT timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  const timezone = rows[0]?.timezone || defaultTimezone();
  return { timezone, today: todayIn(timezone) };
}

function expectedVersion(req) {
  const raw = req.get('If-Match') ?? req.body?.version;
  if (raw === undefined || raw === null || raw === '') {
    throw new InventoryError(428, { error: 'version_required', message: 'Send the entry version you are changing (If-Match header or "version").' });
  }
  const n = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) throw C.bad('version must be a positive whole number.');
  return n;
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────────
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const s = await C.readSettings(pool, req.user.id);
    const loc = await location(pool, req.user.id);
    res.json({
      country_code: s?.country_code ?? null, confirmed: Boolean(s), confirmed_at: s?.confirmed_at ?? null, version: s?.version ?? null,
      suggested_country: C.suggestCountry(loc.timezone), location_timezone: loc.timezone,
      supported: C.SUPPORTED.map(code => ({ code, name: C.CATALOG[code].name })),
      calendar_in_replenishment: C.enabled(),
      note: 'The country decides which holidays are shown. It is never inferred from the timezone alone: please confirm it.',
    });
  } catch (err) { fail(res, err, 'loading calendar settings'); }
});

router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const code = String(req.body?.country_code || '').trim().toUpperCase();
    if (!C.SUPPORTED.includes(code)) throw C.bad(`country_code must be one of: ${C.SUPPORTED.join(', ')}.`);
    const row = await tx(req.user.id, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO calendar_settings (seller_id, country_code, confirmed_by) VALUES ($1, $2, $1)
         ON CONFLICT (seller_id) DO UPDATE SET country_code = EXCLUDED.country_code, confirmed_by = EXCLUDED.confirmed_by,
           confirmed_at = NOW(), version = calendar_settings.version + 1
         RETURNING country_code, confirmed_at, version`, [req.user.id, code]);
      return rows[0];
    });
    res.json({ ...row, confirmed: true });
  } catch (err) { fail(res, err, 'saving calendar settings'); }
});

// ── Calendar view ──────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const loc = await location(pool, req.user.id);
    const from = req.query.from ? String(req.query.from) : loc.today;
    const to = req.query.to ? String(req.query.to) : C.addDays(from, 90);
    if (!C.isDay(from) || !C.isDay(to)) throw C.bad('from and to must be dates written YYYY-MM-DD.');
    if (to < from) throw C.bad('to must not be before from.');
    if (Date.parse(to) - Date.parse(from) > 400 * 86400000) throw C.bad('Ask for at most 400 days at a time.');
    const settings = await C.readSettings(pool, req.user.id);
    const confirmations = settings ? await C.readConfirmations(pool, req.user.id, settings.country_code) : [];
    const entries = await C.readEntries(pool, req.user.id, { from, to, includeCancelled: req.query.include_cancelled === 'true' });
    res.json({
      from, to, timezone: loc.timezone, today: loc.today,
      country_code: settings?.country_code ?? null, country_confirmed: Boolean(settings),
      holidays: settings ? C.holidays(settings.country_code, from, to, confirmations) : [],
      holiday_note: 'Holidays are context: effect unknown. The forecast is not changed for them. '
        + 'Enter a closure or a demand change if you expect one.',
      entries: entries.map(C.withLabel),
      labels: C.LABELS,
      calendar_in_replenishment: C.enabled(),
    });
  } catch (err) { fail(res, err, 'loading the calendar'); }
});

// ── Holiday confirmation ───────────────────────────────────────────────────────────────────────
router.post('/holidays/confirm', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const settings = await C.readSettings(pool, req.user.id);
    if (!settings) throw new InventoryError(409, { error: 'country_not_confirmed', message: 'Confirm your country first.' });
    const ev = C.CATALOG[settings.country_code].events.find(e => e.key === b.event_key);
    if (!ev) throw C.bad(`event_key must be one of: ${C.CATALOG[settings.country_code].events.map(e => e.key).join(', ')}.`);
    const year = Number(b.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw C.bad('year must be a four-digit year.');
    if (!C.isDay(b.start)) throw C.bad('start must be a date written YYYY-MM-DD.');
    const end = b.end ? String(b.end) : C.addDays(b.start, (ev.days || 1) - 1);
    if (!C.isDay(end) || end < b.start || (Date.parse(end) - Date.parse(b.start)) / 86400000 > 6) throw C.bad('end must be on or after start, at most 6 days later.');
    const expected = C.holidays(settings.country_code, `${year - 1}-12-01`, `${year + 1}-01-31`).find(h => h.key === ev.key && h.year === year);
    if (!expected) throw C.bad(`No ${ev.name} is expected in ${year}.`);
    const off = Math.abs(Date.parse(b.start) - Date.parse(expected.start)) / 86400000;
    if (off > 7) throw C.bad(`${ev.name} ${year} is expected around ${expected.start}; a local date more than 7 days away is not accepted.`);
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) throw C.bad('note must be text of at most 500 characters.');
    const row = await tx(req.user.id, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO calendar_holiday_confirmations (seller_id, country_code, event_key, year, confirmed_start, confirmed_end, note, confirmed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $1)
         RETURNING id, event_key, year, to_char(confirmed_start, 'YYYY-MM-DD') AS confirmed_start, to_char(confirmed_end, 'YYYY-MM-DD') AS confirmed_end, confirmed_at`,
        [req.user.id, settings.country_code, ev.key, year, b.start, end, b.note || null]);
      return rows[0];
    });
    res.status(201).json({ ...row, expected_start: expected.start, note: 'Recorded. A later confirmation for the same holiday replaces this one; history is kept.' });
  } catch (err) { fail(res, err, 'confirming the holiday date'); }
});

// ── Entries ────────────────────────────────────────────────────────────────────────────────────
async function normalise(db, sellerId, b, base = {}) {
  const v = { ...base, ...b };
  const out = {};
  if (!KINDS.includes(v.kind)) throw C.bad(`kind must be one of: ${KINDS.join(', ')}.`);
  out.kind = v.kind;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) throw C.bad('title is required (at most 160 characters).');
  out.title = v.title.trim();
  if (!C.isDay(v.start_date) || !C.isDay(v.end_date)) throw C.bad('start_date and end_date must be dates written YYYY-MM-DD.');
  if (v.end_date < v.start_date) throw C.bad('end_date must not be before start_date.');
  if ((Date.parse(v.end_date) - Date.parse(v.start_date)) / 86400000 > 366) throw C.bad('An entry can cover at most 367 days.');
  out.start_date = v.start_date; out.end_date = v.end_date;
  const scope = v.kind === 'closure' ? 'all' : v.kind === 'supplier_delay' ? 'supplier' : (v.scope || 'all');
  if (!SCOPES.includes(scope)) throw C.bad(`scope must be one of: ${SCOPES.join(', ')}.`);
  if (v.kind === 'closure' && v.scope && v.scope !== 'all') throw C.bad('A closure covers the whole location (scope "all").');
  if (v.kind === 'supplier_delay' && v.scope && v.scope !== 'supplier') throw C.bad('A supplier delay has scope "supplier".');
  if ((v.kind === 'promotion' || v.kind === 'demand_scenario') && scope === 'supplier') throw C.bad('Promotions and demand changes apply to all products, a category or listed products.');
  out.scope = scope;
  out.scope_category = null; out.scope_product_ids = null; out.supplier_id = null;
  if (scope === 'category') {
    if (typeof v.scope_category !== 'string' || !v.scope_category.trim()) throw C.bad('scope_category is required for scope "category".');
    const { rows } = await db.query('SELECT 1 FROM products WHERE user_id = $1 AND lower(btrim(category)) = lower(btrim($2)) LIMIT 1', [sellerId, v.scope_category]);
    if (!rows.length) throw C.bad(`None of your products has the category "${v.scope_category.trim()}".`);
    out.scope_category = v.scope_category.trim();
  }
  if (scope === 'products') {
    const ids = Array.isArray(v.scope_product_ids) ? [...new Set(v.scope_product_ids.map(Number))] : [];
    if (!ids.length || ids.length > 500 || ids.some(x => !Number.isInteger(x) || x < 1)) throw C.bad('scope_product_ids must list 1 to 500 of your product ids.');
    const { rows } = await db.query('SELECT id FROM products WHERE user_id = $1 AND id = ANY($2::int[])', [sellerId, ids]);
    if (rows.length !== ids.length) throw notFound('Product');
    out.scope_product_ids = ids.sort((x, y) => x - y);
  }
  if (scope === 'supplier') {
    const id = ownId(v.supplier_id);
    if (!id) throw C.bad('supplier_id is required for a supplier delay.');
    const { rows } = await db.query('SELECT id FROM suppliers WHERE seller_id = $1 AND id = $2', [sellerId, id]);
    if (!rows.length) throw notFound('Supplier');
    out.supplier_id = id;
  }
  out.demand_change_pct = null; out.extra_delay_days = null;
  if (v.kind === 'demand_scenario' || v.kind === 'promotion') {
    const raw = v.demand_change_pct;
    if (raw === undefined || raw === null || raw === '') {
      if (v.kind === 'demand_scenario') throw C.bad('A demand scenario needs demand_change_pct (for example 40 for +40%, -30 for −30%).');
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < -100 || n > 1000) throw C.bad('demand_change_pct must be a number from -100 to 1000.');
      if (n === 0) throw C.bad('A demand change of 0% changes nothing; leave it empty for an information-only promotion.');
      out.demand_change_pct = Math.round(n * 100) / 100;
    }
  }
  if (v.kind === 'supplier_delay') {
    const n = Number(v.extra_delay_days);
    if (!Number.isInteger(n) || n < 1 || n > 180) throw C.bad('extra_delay_days must be a whole number from 1 to 180.');
    out.extra_delay_days = n;
  }
  if (v.notes !== undefined && v.notes !== null && (typeof v.notes !== 'string' || v.notes.length > 2000)) throw C.bad('notes must be text of at most 2000 characters.');
  out.notes = v.notes || null;
  return out;
}

async function overlaps(db, sellerId, e, excludeId = null) {
  if (e.demand_change_pct === null) return [];
  const { rows } = await db.query(
    `SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date, scope
     FROM calendar_entries WHERE seller_id = $1 AND status = 'active' AND demand_change_pct IS NOT NULL
       AND start_date <= $3::date AND end_date >= $2::date AND ($4::int IS NULL OR id <> $4)`,
    [sellerId, e.start_date, e.end_date, excludeId]);
  return rows;
}

const view = async (db, sellerId, id) => {
  const { rows } = await db.query(`SELECT ${C.ENTRY_COLUMNS} FROM calendar_entries WHERE seller_id = $1 AND id = $2`, [sellerId, id]);
  return rows[0] || null;
};

router.post('/entries', authMiddleware, async (req, res) => {
  try {
    const out = await tx(req.user.id, async (c) => {
      const e = await normalise(c, req.user.id, req.body || {});
      const { rows } = await c.query(
        `INSERT INTO calendar_entries (seller_id, kind, title, start_date, end_date, scope, scope_category, scope_product_ids, supplier_id,
           demand_change_pct, extra_delay_days, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $1) RETURNING id`,
        [req.user.id, e.kind, e.title, e.start_date, e.end_date, e.scope, e.scope_category, e.scope_product_ids, e.supplier_id,
          e.demand_change_pct, e.extra_delay_days, e.notes]);
      const entry = await view(c, req.user.id, rows[0].id);
      await c.query(`INSERT INTO calendar_entry_events (seller_id, entry_id, event, after, actor) VALUES ($1, $2, 'created', $3, $1)`,
        [req.user.id, entry.id, entry]);
      return { entry, overlapping_demand_changes: await overlaps(c, req.user.id, e, entry.id) };
    });
    res.status(201).json({ ...out, entry: C.withLabel(out.entry), label: C.entryLabel(out.entry), label_text: C.LABELS[C.entryLabel(out.entry)],
      note: out.overlapping_demand_changes.length
        ? 'Another demand change overlaps these dates. Where both apply to the same product, that product gets no order quantity until one is changed.'
        : null });
  } catch (err) { fail(res, err, 'saving the calendar entry'); }
});

router.patch('/entries/:id', authMiddleware, async (req, res) => {
  try {
    const id = ownId(req.params.id);
    if (!id) throw notFound();
    const version = expectedVersion(req);
    const out = await tx(req.user.id, async (c) => {
      const before = await view(c, req.user.id, id);
      if (!before) throw notFound();
      if (before.status !== 'active') throw new InventoryError(409, { error: 'entry_cancelled', message: 'A cancelled entry cannot be changed; add a new one.' });
      if (before.version !== version) throw new InventoryError(409, { error: 'version_conflict', message: 'The entry changed since you loaded it. Reload it.', current: before });
      const body = { ...req.body };
      delete body.version;
      if (body.kind && body.kind !== before.kind) throw C.bad('The kind of an entry cannot change; cancel it and add a new one.');
      const e = await normalise(c, req.user.id, body, before);
      await c.query(
        `UPDATE calendar_entries SET title = $3, start_date = $4, end_date = $5, scope = $6, scope_category = $7, scope_product_ids = $8,
           supplier_id = $9, demand_change_pct = $10, extra_delay_days = $11, notes = $12, version = version + 1, updated_at = NOW()
         WHERE seller_id = $1 AND id = $2`,
        [req.user.id, id, e.title, e.start_date, e.end_date, e.scope, e.scope_category, e.scope_product_ids, e.supplier_id,
          e.demand_change_pct, e.extra_delay_days, e.notes]);
      const after = await view(c, req.user.id, id);
      await c.query(`INSERT INTO calendar_entry_events (seller_id, entry_id, event, before, after, actor) VALUES ($1, $2, 'updated', $3, $4, $1)`,
        [req.user.id, id, before, after]);
      return { entry: after, overlapping_demand_changes: await overlaps(c, req.user.id, e, id) };
    });
    res.json({ ...out, entry: C.withLabel(out.entry) });
  } catch (err) { fail(res, err, 'changing the calendar entry'); }
});

router.post('/entries/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const id = ownId(req.params.id);
    if (!id) throw notFound();
    const version = expectedVersion(req);
    const entry = await tx(req.user.id, async (c) => {
      const before = await view(c, req.user.id, id);
      if (!before) throw notFound();
      if (before.status === 'cancelled') return before;
      if (before.version !== version) throw new InventoryError(409, { error: 'version_conflict', message: 'The entry changed since you loaded it. Reload it.', current: before });
      await c.query(`UPDATE calendar_entries SET status = 'cancelled', version = version + 1, updated_at = NOW() WHERE seller_id = $1 AND id = $2`, [req.user.id, id]);
      const after = await view(c, req.user.id, id);
      await c.query(`INSERT INTO calendar_entry_events (seller_id, entry_id, event, before, after, actor) VALUES ($1, $2, 'cancelled', $3, $4, $1)`,
        [req.user.id, id, before, after]);
      return after;
    });
    res.json({ entry: C.withLabel(entry) });
  } catch (err) { fail(res, err, 'cancelling the calendar entry'); }
});

router.get('/entries/:id/history', authMiddleware, async (req, res) => {
  try {
    const id = ownId(req.params.id);
    if (!id || !(await view(pool, req.user.id, id))) throw notFound();
    const { rows } = await pool.query(
      'SELECT id, event, before, after, at FROM calendar_entry_events WHERE seller_id = $1 AND entry_id = $2 ORDER BY id', [req.user.id, id]);
    res.json({ entry_id: id, events: rows });
  } catch (err) { fail(res, err, 'loading the entry history'); }
});

module.exports = router;
