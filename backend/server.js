const dotenv = require('dotenv');

dotenv.config();

const app = require('./app');
const createTables = require('./config/initDb');

const PORT = process.env.PORT || 5000;

createTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NexusCommerce server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
