const { Pool, types } = require('pg');

// DATE columns hold business-local calendar days (see lib/imports.js). Return
// them as 'YYYY-MM-DD' strings: pg's default turns them into a JS Date at the
// server's local midnight, which JSON then prints in UTC — a day early for
// any server east of UTC.
types.setTypeParser(types.builtins.DATE, (value) => value);
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  // Optional limits (used by the one-connection pool tests). Defaults are pg's.
  max: Number(process.env.DB_POOL_MAX) || 10,
  connectionTimeoutMillis: Number(process.env.DB_POOL_TIMEOUT_MS) || 0,
});

// Test the connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
