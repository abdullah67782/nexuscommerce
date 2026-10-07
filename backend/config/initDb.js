// Schema setup now lives in versioned migrations (migrations/NNN_*.sql, run by
// db/migrate.js). This file is kept so existing commands keep working:
//   node config/initDb.js   ==   npm run migrate   (applies pending migrations)
// Server startup no longer creates or alters tables; it only checks the schema.
const pool = require('./db');
const { migrate } = require('../db/migrate');

const createTables = () => migrate(pool, { log: (m) => console.log(m) });

module.exports = createTables;

if (require.main === module) {
  createTables()
    .then((ran) => {
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Schema already current.');
      return pool.end();
    })
    .catch((err) => { console.error('Database initialization failed:', err.message); process.exit(1); });
}
