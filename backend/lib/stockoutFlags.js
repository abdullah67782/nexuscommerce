// Stock-out evidence in a product's sales history (Stage 3 proposal §7.5, decision Q6: flag, never impute).
//
// Sales recorded while a product is out of stock understate demand. The ledger can show some of those days; a
// heuristic can point at others. Both are REPORTED with the forecast and its upper estimates. Nothing is censored,
// imputed or adjusted: the forecast, its history and replenishment are unchanged.
//
//   supported   a verified count of 0 (business day C) followed by a purchase receipt (day R) where: no count above 0
//               lies in between; NO stock was added in between by any other movement (customer return, found stock,
//               correction); and EVERY day C..R-1 is a confirmed day with no sales (an unknown day never counts as a
//               zero). Days C..R-1 are "out of stock by your records". Even then sales on those days only MAY
//               understate demand (it is not stated as a fact).
//   suspected   a run of ≥ 3 consecutive confirmed days without sales, outside your declared closures and outside
//               supported periods, for a product that sold on ≥ 80% of the 180 days before the run (at least 56 days
//               of earlier history). Not confirmed: it may be a real lull.
//   current     the latest count is 0 and no receipt has been recorded since.
'use strict';

const VERSION = 'stockout-flags-1';
const MIN_RUN = 3;
const REGULAR_SHARE = 0.8;
const WINDOW = 180;
const MIN_PRIOR = 56;

const dayIn = (instant, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(instant));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const between = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function evidence(db, sellerId, productId) {
  const { rows: [loc] } = await db.query('SELECT timezone FROM inventory_locations WHERE seller_id = $1 AND is_default', [sellerId]);
  const tz = loc?.timezone || process.env.DEFAULT_TIMEZONE || 'Asia/Karachi';
  const { rows: counts } = await db.query(
    `SELECT observed_at, quantity FROM stock_snapshots
     WHERE seller_id = $1 AND product_id = $2 AND status = 'active' AND observed_at IS NOT NULL ORDER BY observed_at`, [sellerId, productId]);
  const { rows: receipts } = await db.query(
    `SELECT kind, effective_at FROM stock_movements WHERE seller_id = $1 AND product_id = $2 AND quantity > 0
     ORDER BY effective_at, id`, [sellerId, productId]);   // every movement that adds stock, not only receipts
  const { rows: closures } = await db.query(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM calendar_entries
     WHERE seller_id = $1 AND kind = 'closure' AND status = 'active'`, [sellerId]).catch(() => ({ rows: [] }));   // before 007
  return { tz, counts, receipts, closures };
}

// history: lib/coverage productHistory(...) result. Pure apart from the evidence argument.
function flags(history, ev) {
  const out = { version: VERSION, supported: [], suspected: [], current: null };
  const { tz, counts, receipts, closures } = ev;
  const usable = history?.usable;
  const sold = new Map();   // confirmed days only; a day missing here is unknown, never zero
  if (usable) usable.quantities.forEach((q, i) => sold.set(addDays(usable.start, i), q));
  const additions = receipts;   // all stock-adding movements (kind + effective_at)

  // Supported: count 0 → receipt, nothing sold in between, no positive count in between.
  for (let k = 0; k < counts.length; k += 1) {
    const c = counts[k];
    if (Number(c.quantity) !== 0) continue;
    const added = additions.find(x => Date.parse(x.effective_at) > Date.parse(c.observed_at));
    const r = added && (added.kind || 'receipt') === 'receipt' ? added : null;
    const nextCount = counts.slice(k + 1).find(x => Date.parse(x.observed_at) > Date.parse(c.observed_at));
    if (added && !r) continue;   // stock was added by a return / found / correction first: not established
    if (!r) {
      if (!nextCount) out.current = { since: dayIn(c.observed_at, tz), text: `Your latest count (${dayIn(c.observed_at, tz)}) is 0 and no stock has been recorded as added since: sales since then may understate demand.` };
      continue;
    }
    if (nextCount && Date.parse(nextCount.observed_at) < Date.parse(r.effective_at) && Number(nextCount.quantity) > 0) continue;
    const start = dayIn(c.observed_at, tz);
    const end = addDays(dayIn(r.effective_at, tz), -1);
    if (end < start) continue;
    let established = true;
    for (let d = start; d <= end; d = addDays(d, 1)) if (!sold.has(d) || sold.get(d) > 0) established = false;   // unknown or sold
    if (!established) continue;
    out.supported.push({ start, end, days: between(start, end) + 1,
      evidence: `Counted 0 on ${start}; next receipt on ${addDays(end, 1)}; no stock added and no sales on any of the confirmed days in between.` });
  }

  // Suspected: zero runs for a usually-daily seller, outside closures and supported periods.
  if (usable) {
    const q = usable.quantities;
    const dayAt = (i) => addDays(usable.start, i);
    const excluded = (d) => closures.some(c => d >= c.s && d <= c.e) || out.supported.some(p => d >= p.start && d <= p.end);
    let i = 0;
    while (i < q.length) {
      if (q[i] > 0 || excluded(dayAt(i))) { i += 1; continue; }
      let j = i;
      while (j + 1 < q.length && q[j + 1] === 0 && !excluded(dayAt(j + 1))) j += 1;
      const len = j - i + 1;
      if (len >= MIN_RUN && i >= MIN_PRIOR) {
        const from = Math.max(0, i - WINDOW);
        const prior = q.slice(from, i);
        const share = prior.filter(x => x > 0).length / prior.length;
        if (share >= REGULAR_SHARE) {
          out.suspected.push({ start: dayAt(i), end: dayAt(j), days: len, selling_share_before: Math.round(share * 1000) / 10,
            reason: `${len} days without sales for a product that sold on ${Math.round(share * 100)}% of the ${prior.length} days before.` });
        }
      }
      i = j + 1;
    }
  }
  return out;
}

const fmt = (ps) => ps.slice(-3).map(p => (p.start === p.end ? p.start : `${p.start} to ${p.end}`)).join(', ')
  + (ps.length > 3 ? ` and ${ps.length - 3} earlier period(s)` : '');

function notes(f) {
  const out = [];
  if (f.supported.length) {
    out.push({ type: 'stockout', text: `Out of stock by your records: ${fmt(f.supported)} (counted 0, then no stock added and no sales on any confirmed day until a receipt). `
      + 'Sales on those days may understate demand. The forecast is not adjusted for them.' });
  }
  if (f.suspected.length) {
    out.push({ type: 'stockout_suspected', text: `Possible stock-outs: ${fmt(f.suspected)} — several days without sales for a product that usually sells most days. `
      + 'Not confirmed; the forecast is not adjusted. Record counts and receipts to confirm.' });
  }
  if (f.current) out.push({ type: 'stockout_current', text: `${f.current.text} The forecast is not adjusted.` });
  return out;
}

async function forProduct(db, sellerId, productId, history) {
  return flags(history, await evidence(db, sellerId, productId));
}

module.exports = { forProduct, flags, notes, VERSION };
