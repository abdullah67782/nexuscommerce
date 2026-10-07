require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT p.name, COUNT(DISTINCT s.sale_date) as days_of_sales 
      FROM products p 
      JOIN sales s ON p.id = s.product_id 
      GROUP BY p.name 
      HAVING COUNT(DISTINCT s.sale_date) >= 30
      ORDER BY days_of_sales DESC 
      LIMIT 10
    `);
    console.log('Products with >= 30 days of sales:');
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
