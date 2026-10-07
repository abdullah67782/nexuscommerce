const pool = require('./config/db');

async function fix() {
  try {
    await pool.query('TRUNCATE sales CASCADE');
    console.log('Truncated sales successfully');
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
fix();
