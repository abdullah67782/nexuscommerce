// Shared setup for the backend regression tests.
//
// The tests run against a real PostgreSQL database and WIPE IT between test
// files, so they refuse to start unless DB_NAME ends in "_test". The ML server
// is replaced by a small local stub that records every call it receives.
const http = require('node:http');
const path = require('node:path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

// Optional test-only settings (copy test/env.example to backend/.env.test).
// Loaded before anything else so the real backend/.env can never point the
// tests at the development database.
dotenv.config({ path: path.join(__dirname, '..', '.env.test'), quiet: true });

if (!process.env.DB_NAME || !process.env.DB_NAME.endsWith('_test')) {
  throw new Error('Refusing to run: set DB_NAME to a dedicated database whose name ends in "_test".');
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const TABLES = [
  'anomalies_detected', 'upload_versions', 'data_freshness', 'finetune_jobs', 'forecasts',
  'model_metrics', 'inventory', 'data_coverage_products', 'data_coverage', 'sales', 'products',
  'data_uploads', 'data_sources', 'users',
];

// ── Fake ML server ──────────────────────────────────────────────────────────
function startMlStub() {
  const stub = {
    calls: [],
    // Set to a function(reqInfo) => {status, body} to override a response.
    override: null,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const info = { method: req.method, url: req.url, body };
      stub.calls.push(info);
      let status = 200;
      let payload = { ok: true };
      const custom = stub.override && stub.override(info);
      if (custom) {
        ({ status, body: payload } = custom);
      } else if (req.url === '/predict/xgboost') {
        const start = new Date('2026-01-01T00:00:00Z');
        payload = {
          predictions: Array.from({ length: body.horizon_days }, (_, i) => ({
            date: new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
            quantity: 10 + i,
          })),
          model_used: 'xgboost_fallback',
          horizon_days: body.horizon_days,
          top_features: [{ feature: 'lag_7', importance: 0.5 }],
          status: 'success',
          accuracy: null,
          residual_std: 2,
        };
      } else if (req.url === '/v2/forecast') {
        // Minimal stand-in for ml/v2 (tested in Python): tier by length, 28-day mean.
        const q = body.quantities;
        const tier = q.length < 28 ? 'insufficient' : q.length < 180 ? 'average' : 'model';
        const mean = q.length ? q.slice(-28).reduce((a, b) => a + b, 0) / Math.min(28, q.length) : 0;
        const last = new Date(Date.parse(`${body.start}T00:00:00Z`) + (q.length - 1) * 86400000);
        const day = (n) => new Date(last.getTime() + n * 86400000).toISOString().slice(0, 10);
        payload = {
          status: tier === 'insufficient' ? 'insufficient_history' : 'ok',
          history: { usable_days: q.length, first_day: body.start, last_day: day(0), tier },
          pattern: tier === 'model' ? { group: 'regular', selling_day_percent: 100, window_days: 180 } : null,
          forecasts: tier === 'insufficient' ? [] : [7, 28].map(h => ({
            horizon_days: h, start: day(1), end: day(h), total_units: mean * h,
            method: tier === 'model' ? 'shared_model' : 'average_28', method_label: 'stub' })),
          models_release: tier === 'model' ? 'stub-release' : null,
        };
      } else if (req.url === '/finetune') {
        payload = { status: 'started', seller_id: body.seller_id };
      } else if (req.url.startsWith('/finetune/status/')) {
        payload = { status: 'idle', seller_id: Number(req.url.split('/').pop()), has_finetuned_model: false };
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      stub.url = `http://127.0.0.1:${server.address().port}`;
      stub.close = () => new Promise(r => server.close(r));
      stub.reset = () => { stub.calls.length = 0; stub.override = null; };
      resolve(stub);
    });
  });
}

// ── App + database lifecycle ────────────────────────────────────────────────
async function setup() {
  const ml = await startMlStub();
  process.env.ML_SERVER_URL = ml.url; // must be set before routes are loaded
  const app = require('../app');
  const pool = require('../config/db');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  await resetDb(pool);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const api = async (method, path, { token, json, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { status: res.status, body: data };
  };

  const teardown = async () => {
    await new Promise(r => server.close(r));
    await ml.close();
    await pool.end();
  };

  return { app, pool, api, ml, teardown, reset: () => resetDb(pool) };
}

async function resetDb(pool) {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

// Register a seller through the real API and return { id, token }.
async function registerSeller(api, email, name = 'Seller') {
  const res = await api('POST', '/auth/register', { json: { name, email, password: 'secret123' } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token, email };
}

function csvForm(csv, filename = 'sales.csv') {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), filename);
  return form;
}

// N consecutive days of sales for each product, ending on `end` (YYYY-MM-DD).
function salesCsv(products, days = 40, end = '2026-01-31', withStock = true) {
  const header = withStock
    ? 'product_name,category,price,quantity,sale_date,revenue,stock_level,reorder_threshold'
    : 'product_name,category,price,quantity,sale_date,revenue';
  const lines = [header];
  const last = new Date(`${end}T00:00:00Z`);
  for (const [pi, name] of products.entries()) {
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(last.getTime() - d * 86400000).toISOString().slice(0, 10);
      const qty = 5 + ((d + pi) % 4);
      const row = [name, 'Electronics', '10.00', qty, date, (qty * 10).toFixed(2)];
      if (withStock) row.push(50, 10);
      lines.push(row.join(','));
    }
  }
  return lines.join('\n');
}

const signToken = (payload, options) => jwt.sign(payload, process.env.JWT_SECRET, options);

module.exports = { setup, registerSeller, csvForm, salesCsv, signToken };
