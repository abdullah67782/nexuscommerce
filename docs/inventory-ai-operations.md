# Inventory AI — operation and rollback

## 1. Services

| Service | Command (Windows development) | Notes |
|---|---|---|
| PostgreSQL | Running service | The database is `nexuscommerce` (from `backend\.env`) |
| ML server | `cd ml` then `venv\Scripts\python.exe -m uvicorn main:app --port 8000` | Loads `ml/models_v2` (hash-checked) and `ml/upper_estimates_v1` (hash-checked, on first request) |
| Backend | `cd backend` then `npm start` (port 5000) | Refuses to start while a migration is pending |
| Frontend | `cd frontend` then `npm run build` and `npm start` (port 3000), or `npm run dev` | — |

## 2. Feature switches (`backend\.env`)

| Switch | Off (default) | On |
|---|---|---|
| `FORECAST_V2_ENABLED` | Legacy forecast page; replenishment shows "forecast unavailable" | v2 totals; replenishment advice |
| `INVENTORY_CALENDAR_ENABLED` | Replenishment is exactly `replenishment-1`; calendar entries are kept but unused | `replenishment-2`: closures, seller demand changes, supplier delays, order-by, late-delivery scenario |
| `FORECAST_UPPER_ESTIMATES_ENABLED` (needs v2) | The upper-estimate panel is hidden | One-sided 80/90% upper estimates where the applicability policy allows |

Other settings:
- `ML_SERVER_URL` (default `http://localhost:8000`);
- `ML_V2_CONCURRENCY` (default 4);
- `DEFAULT_TIMEZONE` (default `Asia/Karachi`; a location's own timezone wins).

Restart the backend after changing `.env`.

## 3. Migrations

Rehearse, then apply (`docs/migration-runbook.md`):

```
cd backend
set "PG_BIN=C:\Program Files\PostgreSQL\18\bin"
node scripts\rehearse-migration.js      (backup + scratch copy + migrate the copy + verify counts)
npm run migrate
npm run migrate:status
```

| Migration | Adds | Reversal (`node db/migrate.js down N`) |
|---|---|---|
| 004 | Stock ledger | Refuses once counts, movements or settings exist |
| 005 | Suppliers and purchasing | Refuses once suppliers, orders or receipts exist |
| 006 | Replenishment log and settings | Refuses once recommendations or settings exist |
| 007 | Store calendar, declared slowest lead time | Refuses once calendar data exists |
| 008 | Upper-estimate answers (store profile, product departments, events) | Refuses once answers exist |

Each refusal changes nothing; the preserving path is the backup made by the rehearsal. Backups live in `backend\backups\` (git-ignored); keep the latest until the migrated app has been checked.

## 4. Rollback by feature (no data loss)

| Feature | Rollback |
|---|---|
| Upper estimates | `FORECAST_UPPER_ESTIMATES_ENABLED=false`. The forecast is unaffected; answers stay stored. |
| Calendar in replenishment | `INVENTORY_CALENDAR_ENABLED=false`. Replenishment returns to `replenishment-1` exactly (test). Older `replenishment-2` recommendations become stale. |
| Forecast v2 | `FORECAST_V2_ENABLED=false`. The legacy page is still available; replenishment shows unavailable; stock and purchasing keep working. |
| Supplier performance, stock-out flags, event notes | Read-only views and notes. They change no record and no number, so there is nothing to roll back. |
| Whole module, database | Restore the pre-migration backup (runbook §3). Imports made after the migration must be redone. |

## 5. Checks

| Check | Command |
|---|---|
| Backend tests (cloud CI-style; a dedicated `*_test` database) | `cd backend` then `npm test` (needs `backend\.env.test`; see `test/env.example`) |
| ML: forecast v2 serving and parity | `cd ml` then `venv\Scripts\python.exe -m unittest tests.test_v2_serving tests.test_v2_parity -v` |
| ML: upper estimates (strict parity in this runtime) | `venv\Scripts\python.exe -m unittest tests.test_upper_estimates -v` |
| Release smoke, Stage 2 | `node scripts\smoke-replenishment.js` |
| Release smoke, Stage 3 | `node scripts\smoke-stage3.js` (needs the three switches on) |
| Frontend | `npm run build`, plus ESLint on the module files |

Smoke tests create a new, clearly named seller (`smoke-…@nexus.local`) and never touch existing sellers.

## 6. What the seller sees when something is missing

| Situation | Behaviour |
|---|---|
| ML server down | Stock, purchasing and receipts work. The forecast says unavailable; advice says unavailable and never guesses; upper estimates show `service_unavailable`. |
| Under 28 confirmed days | No forecast and no quantity. Under 180 days: average-based estimate; no upper estimate. |
| No or old stock count | Ask for a count (unknown ≠ 0); stale counts make advice indicative |
| Lead time or cost missing | A request to set them; unit planning only |
| Supplier with few orders | Performance shown with counts; learned estimate "Not enough history" |
| Store outside the US, or the profile or department not confirmed | Upper estimate unavailable with the reason; forecast shown |
