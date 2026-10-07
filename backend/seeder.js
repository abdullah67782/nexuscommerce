const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'nexuscommerce',
});

const seedDatabase = async () => {
  try {
    console.log('Starting database seeding...');

    // 1. Seed Users
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('password123', salt);

    const users = [
      { name: 'Seller User', email: 'seller@nexus.com', role: 'seller' },
      { name: 'Analyst User', email: 'analyst@nexus.com', role: 'analyst' },
      { name: 'Admin User', email: 'admin@nexus.com', role: 'admin' },
    ];

    for (const user of users) {
      await pool.query(
        'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
        [user.name, user.email, passwordHash, user.role]
      );
    }
    console.log('✓ Users seeded');

    // Fetch user IDs
    const userRes = await pool.query('SELECT id, role, email FROM users');
    // Demo products belong to the demo seller. Products without an owner are
    // invisible to every account since seller isolation was enforced.
    const sellerId = userRes.rows.find(u => u.email === 'seller@nexus.com')?.id;

    // 2. Seed Products (10 products across 3 categories)
    const products = [
      { name: 'Wireless Mouse', category: 'Electronics', price: 29.99 },
      { name: 'Mechanical Keyboard', category: 'Electronics', price: 89.99 },
      { name: 'Gaming Headset', category: 'Electronics', price: 59.99 },
      { name: 'USB-C Hub', category: 'Electronics', price: 39.99 },
      { name: 'Desk Mat', category: 'Accessories', price: 19.99 },
      { name: 'Monitor Stand', category: 'Accessories', price: 49.99 },
      { name: 'Ergonomic Chair', category: 'Furniture', price: 199.99 },
      { name: 'Standing Desk', category: 'Furniture', price: 299.99 },
      { name: 'Webcam 1080p', category: 'Electronics', price: 79.99 },
      { name: 'Cable Management Kit', category: 'Accessories', price: 14.99 },
    ];

    // Clear upload history first: products and sales reference data_uploads,
    // so truncating it later with CASCADE would wipe the freshly seeded rows.
    await pool.query('TRUNCATE data_uploads CASCADE');
    await pool.query('TRUNCATE products CASCADE');
    for (const p of products) {
      await pool.query(
        'INSERT INTO products (name, category, current_price, user_id) VALUES ($1, $2, $3, $4)',
        [p.name, p.category, p.price, sellerId]
      );
    }
    console.log('✓ Products seeded');

    // Fetch product IDs
    const prodRes = await pool.query('SELECT id, current_price FROM products');
    const productRows = prodRes.rows;

    // 3. Seed Inventory & Sales
    await pool.query('TRUNCATE inventory CASCADE');
    await pool.query('TRUNCATE sales CASCADE');
    
    let totalRecords = 0;
    
    for (const p of productRows) {
      // Inventory
      await pool.query(
        'INSERT INTO inventory (product_id, stock_level, reorder_threshold) VALUES ($1, $2, $3)',
        [p.id, Math.floor(Math.random() * 200) + 20, 30]
      );

      // 90 Sales records per product (one per day for the last 90 days)
      for (let i = 0; i < 90; i++) {
        const date = new Date();
        date.setDate(date.getDate() - (90 - i)); // sequentially past 90 days up to today
        const qty = Math.floor(Math.random() * 10) + 1;
        const revenue = p.current_price * qty;

        await pool.query(
          'INSERT INTO sales (product_id, quantity, sale_date, revenue) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
          [p.id, qty, date.toISOString().split('T')[0], revenue]
        );
        totalRecords++;
      }
    }
    console.log(`✓ Inventory seeded`);
    console.log(`✓ Sales seeded (${totalRecords} records)`);

    // 4. Seed Data Uploads record
    await pool.query(
      'INSERT INTO data_uploads (uploaded_by, file_format, total_records, clean_records, quality_score) VALUES ($1, $2, $3, $4, $5)',
      [sellerId, 'CSV', totalRecords, totalRecords, 98.5]
    );
    console.log('✓ Data upload history seeded');

    // 5. Seed Model Metrics
    await pool.query('TRUNCATE model_metrics CASCADE');
    const metrics = [
      { name: 'RandomForest', mae: 189, rmse: 241, r2: 0.84, mape: 9 },
      { name: 'XGBoost', mae: 118, rmse: 176, r2: 0.93, mape: 6 },
    ];

    for (const m of metrics) {
      await pool.query(
        'INSERT INTO model_metrics (model_name, mae, rmse, r2_score, mape) VALUES ($1, $2, $3, $4, $5)',
        [m.name, m.mae, m.rmse, m.r2, m.mape]
      );
    }
    console.log('✓ Model metrics seeded');

    console.log('\n✅ Database seeding completed successfully!');
  } catch (err) {
    console.error('Seeding error:', err.message);
  } finally {
    pool.end();
  }
};

seedDatabase();
