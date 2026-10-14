// Forecast v2 service, shared by the forecast route and the Stage 2 replenishment
// loader, so neither calls the other through a user-facing route.
//
// Moved out of routes/forecast.js WITHOUT behaviour change: the same ML calls
// (POST /v2/forecast with the confirmed usable history), the same error handling
// and the same explanation notes. The models, the tier/method routing and the
// response of GET /api/forecast/v2/:id are unchanged.
//
// Added for the replenishment queue only:
//   * forecastFromHistory(history, { cache: true }) — a per-process cache keyed by
//     the history fingerprint (usable start + daily quantities). Entries expire after
//     CACHE_TTL_MS so a newly deployed release is picked up; only successful results
//     are cached. The forecast route does not use the cache.
//   * bounded concurrency (ML_V2_CONCURRENCY, default 4) for every v2 forecast call.
const axios = require('axios');
const crypto = require('node:crypto');
const { addDays } = require('./coverage');
const { stableStringify } = require('./imports');

const mlServer = () => process.env.ML_SERVER_URL || 'http://localhost:8000';

async function callMLServer(method, endpoint, data = null, timeout = 30000) {
  try {
    const url = `${mlServer()}${endpoint}`;
    const config = { timeout };
    const response = method === 'GET'
      ? await axios.get(url, config)
      : await axios.post(url, data, config);
    return response.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error('ML server is not running. Start it with: python ml/main.py');
    }
    if (err.response) {
      // Preserve the original status + body for 422 insufficient_history passthrough
      const e = new Error(err.response.data?.detail || err.response.data?.message || 'ML server error');
      e.mlStatus = err.response.status;
      e.mlData = err.response.data;
      throw e;
    }
    throw new Error(`ML server request failed: ${err.message}`);
  }
}

// ── Bounded concurrency ──────────────────────────────────────────────────────
const LIMIT = Math.max(1, Number(process.env.ML_V2_CONCURRENCY) || 4);
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= LIMIT) await new Promise(resolve => waiting.push(resolve));
  active += 1;
  try { return await fn(); } finally {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

// ── Cache (replenishment only) ───────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map();      // key → { at, result }
const inFlight = new Map();   // key → Promise
const historyFingerprint = (history) => (history && history.usable
  ? crypto.createHash('sha256').update(stableStringify({ start: history.usable.start, quantities: history.usable.quantities })).digest('hex')
  : null);

// The v2 result for a product's resolved history (lib/coverage productHistory).
// No usable history → the same 'needs_confirmation' result the route returns.
async function forecastFromHistory(history, { cache: useCache = false } = {}) {
  if (!history.usable) {
    return { status: 'needs_confirmation', pattern: null, forecasts: [], models_release: null,
      history: { usable_days: 0, first_day: null, last_day: null, tier: 'insufficient', required_days: { average: 28, model: 180 } } };
  }
  const call = () => limited(() => callMLServer('POST', '/v2/forecast',
    { start: history.usable.start, quantities: history.usable.quantities }, 60000));
  if (!useCache) return call();
  const key = historyFingerprint(history);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = call().then((result) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), result });
    return result;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
const clearCache = () => cache.clear();

// ── Explanation notes (unchanged from routes/forecast.js) ────────────────────
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const listPeriods = (periods, max = 3) => periods.slice(-max).map(p => (p.start === p.end ? p.start : `${p.start} to ${p.end}`)).join(', ')
  + (periods.length > max ? ` and ${periods.length - max} earlier period${periods.length - max === 1 ? '' : 's'}` : '');

function explainV2(history, result, today) {
  const notes = [];
  const usable = history.usable;
  const tier = result.history.tier;
  const { counts } = history;

  if (counts.unconfirmed > 0) {
    notes.push({ type: 'confirmation', text: `${plural(counts.unconfirmed, 'day')} have sales records that are not confirmed complete `
      + `(${listPeriods(history.unconfirmed_periods)}). The records stay in your sales data, but a day with some records can still be `
      + 'missing sales, so these days do not count as forecasting history. Confirm the period each upload covers on the Data Integration page.' });
  }
  const before = history.before_usable;
  if (usable && before) {
    notes.push({ type: 'cut', text: before.state === 'unconfirmed'
      ? `Forecasting history starts on ${usable.start}, right after the unconfirmed records of ${before.start} to ${before.end}.`
      : `Forecasting history starts on ${usable.start}. The ${plural(before.days, 'day')} before it (${before.start} to ${before.end}) `
        + 'have no records and no confirmed period, so they are unknown, not zero.' });
  }
  const after = history.after_usable;
  if (usable && after && after.unconfirmed_days > 0) {
    notes.push({ type: 'after', text: `Sales recorded after ${usable.end} (up to ${after.end}) are not confirmed yet, `
      + `so forecasts start on ${addDays(usable.end, 1)}.` });
  }
  if (counts.missing > 0 && !(before && before.state === 'missing' && before.days === counts.missing)) {
    notes.push({ type: 'missing', text: `${plural(counts.missing, 'day')} since the first sale on ${history.first_sale} have no records and no `
      + 'confirmed period. They are unknown and are never treated as zero.' });
  }
  if (!usable) {
    notes.push({ type: 'tier', text: 'No confirmed days yet, so there is no forecast. A forecast needs at least 28 consecutive confirmed days.' });
  } else if (tier === 'insufficient') {
    notes.push({ type: 'tier', text: `Only ${plural(usable.days, 'consecutive confirmed day')} are available; at least 28 are needed for an estimate.` });
  } else if (tier === 'average') {
    notes.push({ type: 'tier', text: `${plural(usable.days, 'consecutive confirmed day')} of history (180 are needed for the model-based forecast). `
      + 'This is an average-based estimate: average daily sales over the last 28 days × the number of days.' });
  } else if (result.pattern) {
    const text = result.pattern.group === 'rare'
      ? 'It sells on fewer than 20% of days, so it uses the rare-sales method (TSB), which follows how often it sells and how much per sale.'
      : 'It has at least 180 confirmed days and does not sell rarely, so it uses the shared forecasting model.';
    notes.push({ type: 'method', text });
  }
  const start = result.forecasts[0]?.start;
  if (start && start < today) {
    notes.push({ type: 'stale', text: `Confirmed history ends on ${usable.end}, so forecasts start on ${start}, not today (${today}). `
      + 'Upload and confirm newer sales for a forecast from today.' });
  }
  return notes;
}

module.exports = { callMLServer, forecastFromHistory, explainV2, historyFingerprint, clearCache, CACHE_TTL_MS };
