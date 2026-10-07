const dotenv = require('dotenv');

dotenv.config();

const app = require('./app');
const pool = require('./config/db');
const { assertSchemaCurrent } = require('./db/migrate');

const PORT = process.env.PORT || 5000;

// Startup never changes the schema (so it can never undo a migration); it only
// refuses to run against a database that is behind. Apply migrations with
// "npm run migrate" after taking a backup.
assertSchemaCurrent(pool)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NexusCommerce server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
