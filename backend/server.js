const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const createTables = require('./config/initDb');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const { router: forecastRoutes, finetuneRouter } = require('./routes/forecast');
const storeRoutes = require('./routes/store');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const corsOptions = {
  origin: ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'NexusCommerce API running' });
});

app.use('/api/auth', authRoutes);
app.use('/api', dataRoutes);
app.use('/api/forecast', forecastRoutes);
app.use('/api/finetune', finetuneRouter);
app.use('/api/store', storeRoutes);

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
