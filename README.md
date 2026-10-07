# NexusCommerce Setup Guide

## Prerequisites
- Node.js v18+
- Python 3.10+
- PostgreSQL 15+

## Setup Steps

### 1. Database
```bash
createdb nexuscommerce
cd backend
npm run migrate          # applies versioned migrations (same as: node config/initDb.js)
node seeder.js           # demo data — destructive, demo databases only
```
The server does not create or change tables on startup; it refuses to start until
pending migrations are applied. Take a backup (`pg_dump -Fc`) before migrating an
existing database. See `docs/import-identity-and-coverage.md`.

Tests: `cd backend && npm test` — needs a separate database whose name ends in
`_test` (copy `backend/test/env.example` to `backend/.env.test`).

### 2. Backend
```bash
cd backend
npm install
cp .env.example .env
# (fill in your database credentials in .env)
npm start
# Runs on: http://localhost:5000
```

### 3. ML Server
```bash
cd ml
python -m venv venv
# On Windows:
venv\Scripts\activate
# On Mac/Linux:
source venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload
# Runs on: http://localhost:8000
```

### 4. Frontend
```bash
cd frontend
npm install
npm run dev
# Runs on: http://localhost:3000
```

## Test Accounts
- **Seller**: `seller@nexus.com` / `password123`
- **Analyst**: `analyst@nexus.com` / `password123`
- **Admin**: `admin@nexus.com` / `password123`

## Demo Flow
1. Login with seller account
2. Go to Data Upload
3. Upload sample CSV file
4. View quality report
5. Go to Dashboard
6. View KPIs and charts
7. Go to Forecasting
8. Select product and generate forecast
9. View model comparison table

---

## Final Testing Checklist

**Flow 1: Authentication**
- [x] Register new account works
- [x] Login with existing account works
- [x] Wrong password shows error
- [x] Protected routes redirect to login
- [x] Logout clears session

**Flow 2: Data Upload**
- [x] CSV file uploads successfully
- [x] Quality report displays after upload
- [x] Data appears in dashboard after upload
- [x] Invalid file type shows error
- [x] Upload history shows past uploads

**Flow 3: Dashboard**
- [x] KPI cards show correct numbers
- [x] Sales chart loads with data
- [x] Model comparison table shows metrics
- [x] Inventory alerts show correctly
- [x] Filters work on sales chart

**Flow 4: Forecasting**
- [x] Products load in dropdown
- [x] Forecast generates successfully
- [x] Chart shows prediction line
- [x] Confidence intervals show as shaded area
- [x] Model comparison charts display
- [x] Export CSV downloads correctly
