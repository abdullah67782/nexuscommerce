// Express application, without starting a server or touching the database
// schema. server.js starts it for real; the test suite imports it directly.
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const { router: forecastRoutes, finetuneRouter } = require('./routes/forecast');
const storeRoutes = require('./routes/store');

const app = express();

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

module.exports = app;
