const pool = require('./db');

const createTables = async () => {
  // ── Step 1: All tables (idempotent) ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'seller',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      name VARCHAR(200) NOT NULL,
      category VARCHAR(100),
      current_price DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id),
      quantity INT NOT NULL,
      sale_date DATE NOT NULL,
      revenue DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id),
      stock_level INT NOT NULL,
      reorder_threshold INT DEFAULT 10,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS forecasts (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES products(id),
      predicted_demand DECIMAL(10,2),
      forecast_date DATE NOT NULL,
      model_used VARCHAR(50),
      confidence_upper DECIMAL(10,2),
      confidence_lower DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS model_metrics (
      id SERIAL PRIMARY KEY,
      model_name VARCHAR(50),
      mae DECIMAL(10,4),
      rmse DECIMAL(10,4),
      r2_score DECIMAL(10,4),
      mape DECIMAL(10,4),
      evaluated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS data_uploads (
      id SERIAL PRIMARY KEY,
      uploaded_by INT REFERENCES users(id),
      file_format VARCHAR(20),
      total_records INT,
      clean_records INT,
      quality_score DECIMAL(5,2),
      uploaded_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS finetune_jobs (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      metrics TEXT,
      error_message TEXT,
      started_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP
    );

    -- Module 1: Anomaly tracking
    CREATE TABLE IF NOT EXISTS anomalies_detected (
      id             SERIAL PRIMARY KEY,
      upload_id      INTEGER REFERENCES data_uploads(id) ON DELETE CASCADE,
      seller_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      product_name   VARCHAR(255),
      field          VARCHAR(100),
      anomaly_type   VARCHAR(100),
      original_value TEXT,
      row_number     INTEGER,
      severity       VARCHAR(20),
      resolved       BOOLEAN DEFAULT false,
      created_at     TIMESTAMP DEFAULT NOW()
    );

    -- Module 1: Upload version history
    CREATE TABLE IF NOT EXISTS upload_versions (
      id             SERIAL PRIMARY KEY,
      seller_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
      upload_id      INTEGER REFERENCES data_uploads(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      rows_added     INTEGER DEFAULT 0,
      rows_skipped   INTEGER DEFAULT 0,
      rows_rejected  INTEGER DEFAULT 0,
      is_rolled_back BOOLEAN DEFAULT false,
      rollback_at    TIMESTAMP,
      created_at     TIMESTAMP DEFAULT NOW()
    );

    -- Module 1: Per-seller data freshness
    CREATE TABLE IF NOT EXISTS data_freshness (
      id              SERIAL PRIMARY KEY,
      seller_id       INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      last_upload_at  TIMESTAMP,
      last_sale_date  DATE,
      total_records   INTEGER DEFAULT 0,
      freshness_score INTEGER DEFAULT 0,
      updated_at      TIMESTAMP DEFAULT NOW()
    );
  `);

  // ── Step 2: Safe column additions (IF NOT EXISTS supported in PG 9.6+) ──────
  await pool.query(`
    ALTER TABLE products      ADD COLUMN IF NOT EXISTS user_id   INT     REFERENCES users(id)        ON DELETE SET NULL;
    ALTER TABLE products      ADD COLUMN IF NOT EXISTS upload_id INTEGER REFERENCES data_uploads(id) ON DELETE SET NULL;
    ALTER TABLE sales         ADD COLUMN IF NOT EXISTS upload_id INTEGER REFERENCES data_uploads(id) ON DELETE SET NULL;
    ALTER TABLE model_metrics ADD COLUMN IF NOT EXISTS seller_id  INT REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE model_metrics ADD COLUMN IF NOT EXISTS accuracy   INT;
    ALTER TABLE forecasts     ADD COLUMN IF NOT EXISTS seller_id  INT REFERENCES users(id) ON DELETE SET NULL;
  `);

  // ── Step 3: Unique constraint for sale dedup (gracefully skip on failure) ───
  try {
    await pool.query(`
      ALTER TABLE sales ADD CONSTRAINT unique_sale_transaction
        UNIQUE (product_id, sale_date, quantity, revenue)
    `);
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.warn('Note: unique_sale_transaction constraint not added:', err.message);
    }
  }

  // ── Step 4: Unique constraint on model_metrics (seller_id, model_name) ─────
  try {
    await pool.query(`
      ALTER TABLE model_metrics ADD CONSTRAINT unique_seller_model
        UNIQUE (seller_id, model_name)
    `);
  } catch (err) {
    if (!err.message.includes('already exists')) {
      console.warn('Note: unique_seller_model constraint not added:', err.message);
    }
  }

  console.log('All tables created successfully');
};

module.exports = createTables;

if (require.main === module) {
  createTables()
    .then(() => { console.log('Database initialization complete'); process.exit(0); })
    .catch((err) => { console.error('Database initialization failed:', err.message); process.exit(1); });
}
