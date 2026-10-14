// Store calendar (Inventory Stage 3a): system holiday catalog, seller confirmations, seller entries.
//
// Holidays are CONTEXT only: no learned effect is applied to demand (Stage 3 final evaluation decides
// whether any event method may be used). What changes a plan is what the SELLER enters:
//   closure          the location is closed: no sales, deliveries usable from the next open day
//   supplier_delay   orders from that supplier expected inside the dates arrive `extra_delay_days` later
//   demand_scenario  the seller's own assumption (+/- %) for the dates — labelled "assumed by seller"
//   promotion        a promotion; with a % it is a seller scenario, without one it is information only
// Dates are business dates in the stock location's timezone (as every Stage 2 date).
'use strict';

const { InventoryError } = require('./stockLedger');

const DAY_MS = 86400000;
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => toDay(dayMs(d) + n * DAY_MS);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && toDay(dayMs(v)) === v;
const bad = (message, extra = {}) => new InventoryError(400, { error: 'invalid_request', message, ...extra });

// ── Islamic dates: arithmetic (tabular) calendar, civil epoch ────────────────────────────────────
// An ESTIMATE. The local date depends on moon sighting and can differ by 1–2 days, so these dates are
// "expected" until the seller confirms them.
function hijriToGregorian(y, m, d) {
  const jd = d + Math.ceil(29.5 * (m - 1)) + (y - 1) * 354 + Math.floor((3 + 11 * y) / 30) + 1948439.5 - 1;
  return toDay(Math.round((jd - 2440587.5) * DAY_MS));
}
const hijriYearsFor = (gy) => { const base = Math.floor((gy - 622) * 33 / 32); return [base - 1, base, base + 1, base + 2]; };

const NTH = (gy, month, weekday, n) => {          // n-th weekday (0 = Sunday) of a month; n = -1 → last
  if (n > 0) {
    const first = new Date(Date.UTC(gy, month - 1, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return toDay(Date.UTC(gy, month - 1, 1 + offset + (n - 1) * 7));
  }
  const last = new Date(Date.UTC(gy, month, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return toDay(Date.UTC(gy, month - 1, last.getUTCDate() - back));
};
const fixed = (gy, m, d) => toDay(Date.UTC(gy, m - 1, d));

// type: national | religious | commercial ; recurrence: fixed | rule | lunar
const CATALOG = {
  PK: {
    name: 'Pakistan',
    timezones: ['Asia/Karachi'],
    events: [
      { key: 'kashmir_day', name: 'Kashmir Solidarity Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 2, 5) },
      { key: 'pakistan_day', name: 'Pakistan Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 3, 23) },
      { key: 'labour_day', name: 'Labour Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 5, 1) },
      { key: 'youm_e_takbeer', name: 'Youm-e-Takbeer', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 5, 28) },
      { key: 'independence_day', name: 'Independence Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 8, 14) },
      { key: 'iqbal_day', name: 'Iqbal Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 11, 9) },
      { key: 'quaid_day', name: 'Quaid-e-Azam Day / Christmas', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 12, 25) },
      { key: 'white_friday', name: 'White Friday sales', type: 'commercial', recurrence: 'rule', date: (y) => NTH(y, 11, 5, -1) },
      { key: 'ramadan_start', name: 'Ramadan begins', type: 'religious', recurrence: 'lunar', hijri: [9, 1], days: 1 },
      { key: 'eid_al_fitr', name: 'Eid al-Fitr', type: 'religious', recurrence: 'lunar', hijri: [10, 1], days: 3 },
      { key: 'eid_al_adha', name: 'Eid al-Adha', type: 'religious', recurrence: 'lunar', hijri: [12, 10], days: 3 },
      { key: 'ashura', name: 'Ashura (9–10 Muharram)', type: 'religious', recurrence: 'lunar', hijri: [1, 9], days: 2 },
      { key: 'eid_milad_un_nabi', name: 'Eid Milad-un-Nabi', type: 'religious', recurrence: 'lunar', hijri: [3, 12], days: 1 },
    ],
  },
  US: {
    name: 'United States',
    timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu'],
    events: [
      { key: 'new_year', name: "New Year's Day", type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 1, 1) },
      { key: 'mlk_day', name: 'Martin Luther King Jr. Day', type: 'national', recurrence: 'rule', date: (y) => NTH(y, 1, 1, 3) },
      { key: 'presidents_day', name: "Presidents' Day", type: 'national', recurrence: 'rule', date: (y) => NTH(y, 2, 1, 3) },
      { key: 'memorial_day', name: 'Memorial Day', type: 'national', recurrence: 'rule', date: (y) => NTH(y, 5, 1, -1) },
      { key: 'juneteenth', name: 'Juneteenth', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 6, 19) },
      { key: 'independence_day', name: 'Independence Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 7, 4) },
      { key: 'labor_day', name: 'Labor Day', type: 'national', recurrence: 'rule', date: (y) => NTH(y, 9, 1, 1) },
      { key: 'thanksgiving', name: 'Thanksgiving', type: 'national', recurrence: 'rule', date: (y) => NTH(y, 11, 4, 4) },
      { key: 'black_friday', name: 'Black Friday sales', type: 'commercial', recurrence: 'rule', date: (y) => addDays(NTH(y, 11, 4, 4), 1) },
      { key: 'christmas', name: 'Christmas Day', type: 'national', recurrence: 'fixed', date: (y) => fixed(y, 12, 25) },
    ],
  },
};
const SUPPORTED = Object.keys(CATALOG);
const suggestCountry = (timezone) => SUPPORTED.find(c => CATALOG[c].timezones.includes(timezone)) || null;

// Labels shown wherever calendar items appear. A holiday has no approved learned effect (Stage 3: the event
// layers E1c and Pakistan E1 failed the final evaluation), so its effect is always 'Effect unknown'. What the
// seller enters keeps its own label: a % change is 'Assumed by you'; a closure or a supplier delay is declared by you.
const EFFECT_UNKNOWN = 'Effect unknown';
const LABELS = {
  assumed_by_seller: 'Assumed by you',
  declared_closure: 'Closure declared by you',
  declared_supplier_delay: 'Supplier delay declared by you',
  information_only: 'Information only',
};
function entryLabel(e) {
  if (e.kind === 'closure') return 'declared_closure';
  if (e.kind === 'supplier_delay') return 'declared_supplier_delay';
  return e.demand_change_pct !== null && e.demand_change_pct !== undefined ? 'assumed_by_seller' : 'information_only';
}
const withLabel = (e) => ({ ...e, label: entryLabel(e), label_text: LABELS[entryLabel(e)] });

// System holidays overlapping [from, to] for a country, with the seller's confirmations applied.
function holidays(country, from, to, confirmations = []) {
  const cat = CATALOG[country];
  if (!cat) return [];
  const out = [];
  const y0 = Number(from.slice(0, 4)) - 1;
  const y1 = Number(to.slice(0, 4)) + 1;
  for (const ev of cat.events) {
    const instances = [];
    if (ev.recurrence === 'lunar') {
      const seen = new Set();
      for (let gy = y0; gy <= y1; gy += 1) {
        for (const hy of hijriYearsFor(gy)) {
          const start = hijriToGregorian(hy, ev.hijri[0], ev.hijri[1]);
          if (seen.has(start)) continue;
          seen.add(start);
          instances.push({ year: Number(start.slice(0, 4)), hijri_year: hy, start, end: addDays(start, ev.days - 1) });
        }
      }
    } else {
      for (let gy = y0; gy <= y1; gy += 1) { const d = ev.date(gy); instances.push({ year: gy, start: d, end: d }); }
    }
    for (const it of instances) {
      const conf = confirmations.find(c => c.event_key === ev.key && c.year === it.year && c.country_code === country);
      const lunar = ev.recurrence === 'lunar';
      const start = conf ? conf.confirmed_start : it.start;
      const end = conf ? conf.confirmed_end : it.end;
      const windowStart = lunar && !conf ? addDays(start, -1) : start;
      const windowEnd = lunar && !conf ? addDays(end, 1) : end;
      if (windowEnd < from || windowStart > to) continue;
      out.push({
        key: ev.key, name: ev.name, country, type: ev.type, recurrence: ev.recurrence, year: it.year,
        start, end,
        status: conf ? 'confirmed_by_seller' : lunar ? 'expected' : 'scheduled',
        possible_dates: lunar && !conf ? { start: windowStart, end: windowEnd } : null,
        source: conf ? 'seller_confirmation' : lunar ? 'astronomical_estimate' : 'official_fixed_or_rule',
        confirmation_id: conf ? conf.id : null,
        note: conf ? `Confirmed by you on ${new Date(conf.confirmed_at).toISOString().slice(0, 10)}.`
          : lunar ? 'Expected date from the Islamic calendar; the local date depends on moon sighting and may differ by 1–2 days. Confirm it when announced.'
            : 'Fixed or rule-based date; an official notification can change it.',
        effect: 'not_known', effect_label: EFFECT_UNKNOWN,
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

// ── Database reads (any client; callers choose the snapshot) ──────────────────────────────────────
async function readSettings(db, sellerId) {
  const { rows } = await db.query(
    'SELECT country_code, confirmed_at, version FROM calendar_settings WHERE seller_id = $1', [sellerId]);
  return rows[0] || null;
}

async function readConfirmations(db, sellerId, country) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (event_key, year) id, country_code, event_key, year,
            to_char(confirmed_start, 'YYYY-MM-DD') AS confirmed_start, to_char(confirmed_end, 'YYYY-MM-DD') AS confirmed_end,
            note, confirmed_at
     FROM calendar_holiday_confirmations WHERE seller_id = $1 AND country_code = $2
     ORDER BY event_key, year, id DESC`, [sellerId, country]);
  return rows;
}

const ENTRY_COLUMNS = `id, kind, title, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
  scope, scope_category, scope_product_ids, supplier_id, demand_change_pct::float8 AS demand_change_pct, extra_delay_days,
  notes, status, version, created_at, updated_at`;

async function readEntries(db, sellerId, { from = null, to = null, includeCancelled = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${ENTRY_COLUMNS} FROM calendar_entries
     WHERE seller_id = $1 AND ($2::date IS NULL OR end_date >= $2::date) AND ($3::date IS NULL OR start_date <= $3::date)
       AND ($4 OR status = 'active')
     ORDER BY start_date, id`, [sellerId, from, to, includeCancelled]);
  return rows;
}

// ── What applies to one product over the planning grid [D, D+days-1] ─────────────────────────────
// The engine receives this plain object (and it is part of the input fingerprint). Only entries that
// touch the grid are included, so an unrelated calendar change does not invalidate a recommendation.
function forProduct({ settings, confirmations, entries }, product, supplierId, D, days = 28) {
  const end = addDays(D, days - 1);
  const touches = (e) => e.end_date >= D && e.start_date <= end;
  const applies = (e) => e.scope === 'all'
    || (e.scope === 'category' && product.category && e.scope_category.trim().toLowerCase() === String(product.category).trim().toLowerCase())
    || (e.scope === 'products' && (e.scope_product_ids || []).includes(product.id))
    || (e.scope === 'supplier' && supplierId !== null && e.supplier_id === supplierId);
  const slim = (e) => ({ id: e.id, version: e.version, kind: e.kind, title: e.title, start_date: e.start_date, end_date: e.end_date,
    scope: e.scope, demand_change_pct: e.demand_change_pct ?? null, extra_delay_days: e.extra_delay_days ?? null });
  const mine = entries.filter(e => e.status === 'active' && applies(e));
  // Supplier delays are looked at beyond the demand grid too (an order's arrival can fall after it).
  const delays = mine.filter(e => e.kind === 'supplier_delay' && e.end_date >= D).map(slim);
  const country = settings?.country_code || null;
  return {
    country,
    country_confirmed: Boolean(settings),
    closures: mine.filter(e => e.kind === 'closure' && touches(e)).map(slim),
    demand_changes: mine.filter(e => (e.kind === 'demand_scenario' || (e.kind === 'promotion' && e.demand_change_pct !== null)) && touches(e)).map(slim),
    promotions_without_change: mine.filter(e => e.kind === 'promotion' && e.demand_change_pct === null && touches(e)).map(slim),
    supplier_delays: delays,
    holidays: country ? holidays(country, D, end, confirmations).map(h => ({ key: h.key, name: h.name, type: h.type, start: h.start, end: h.end,
      status: h.status, possible_dates: h.possible_dates, effect: h.effect, effect_label: h.effect_label })) : [],
  };
}

async function readAll(db, sellerId) {
  const settings = await readSettings(db, sellerId);
  const confirmations = settings ? await readConfirmations(db, sellerId, settings.country_code) : [];
  const entries = await readEntries(db, sellerId);
  return { settings, confirmations, entries };
}

const enabled = () => process.env.INVENTORY_CALENDAR_ENABLED === 'true';

module.exports = {
  CATALOG, SUPPORTED, suggestCountry, holidays, hijriToGregorian, readSettings, readConfirmations, readEntries, readAll,
  forProduct, enabled, isDay, addDays, bad, ENTRY_COLUMNS, EFFECT_UNKNOWN, LABELS, entryLabel, withLabel,
};
