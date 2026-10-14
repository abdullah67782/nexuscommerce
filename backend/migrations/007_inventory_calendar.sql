-- 007 — Inventory Stage 3a: store calendar, seller demand scenarios, supplier delays and a declared
-- lead-time range. Facts and assumptions entered by the seller; nothing here is learned or predicted.
--
-- Adds only:
--   * calendar_settings: the seller's CONFIRMED country (a timezone only suggests one);
--   * calendar_holiday_confirmations: append-only local dates for moon-sighting holidays (Eid…);
--   * calendar_entries (+ append-only calendar_entry_events): promotions, closures, supplier delays and
--     seller demand scenarios, each with dates in the stock location's timezone and a scope;
--   * product_suppliers.lead_time_max_days: the supplier's declared slowest delivery (planning scenario).
-- No change to stock, orders, forecasts or recommendations already recorded.

CREATE TABLE calendar_settings (
  seller_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  country_code  CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  confirmed_by  INT NOT NULL REFERENCES users(id),
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version       INT NOT NULL DEFAULT 1 CHECK (version >= 1)
);

-- Local date of a moon-sighting holiday as the seller confirms it. Append-only: a correction adds a
-- row; the latest row for (seller, country, event, year) is the one in force.
CREATE TABLE calendar_holiday_confirmations (
  id               SERIAL PRIMARY KEY,
  seller_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_code     CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  event_key        VARCHAR(60) NOT NULL CHECK (event_key ~ '^[a-z0-9_]+$'),
  year             INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  confirmed_start  DATE NOT NULL,
  confirmed_end    DATE NOT NULL,
  note             TEXT,
  confirmed_by     INT NOT NULL REFERENCES users(id),
  confirmed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (confirmed_end >= confirmed_start AND confirmed_end - confirmed_start <= 6)
);
CREATE INDEX calendar_holiday_confirmations_lookup
  ON calendar_holiday_confirmations (seller_id, country_code, event_key, year, id DESC);
CREATE TRIGGER calendar_holiday_confirmations_append_only BEFORE UPDATE OR DELETE ON calendar_holiday_confirmations
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();

CREATE TABLE calendar_entries (
  id                 SERIAL PRIMARY KEY,
  seller_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               VARCHAR(20) NOT NULL CHECK (kind IN ('promotion', 'closure', 'supplier_delay', 'demand_scenario')),
  title              VARCHAR(160) NOT NULL CHECK (btrim(title) <> ''),
  start_date         DATE NOT NULL,                 -- business dates in the stock location's timezone
  end_date           DATE NOT NULL,
  scope              VARCHAR(12) NOT NULL CHECK (scope IN ('all', 'category', 'products', 'supplier')),
  scope_category     VARCHAR(255),
  scope_product_ids  INT[],
  supplier_id        INT,
  demand_change_pct  NUMERIC(6,2) CHECK (demand_change_pct BETWEEN -100 AND 1000),
  extra_delay_days   INT CHECK (extra_delay_days BETWEEN 1 AND 180),
  notes              TEXT,
  status             VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  version            INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by         INT NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_id),
  CONSTRAINT calendar_entries_supplier_fk FOREIGN KEY (supplier_id, seller_id) REFERENCES suppliers (id, seller_id),
  CHECK (end_date >= start_date AND end_date - start_date <= 366),
  CHECK (scope <> 'category' OR (scope_category IS NOT NULL AND btrim(scope_category) <> '')),
  CHECK (scope <> 'products' OR cardinality(scope_product_ids) BETWEEN 1 AND 500),
  CHECK (scope <> 'supplier' OR supplier_id IS NOT NULL),
  -- Kind rules: a closure is the whole location; a supplier delay names a supplier and its extra days;
  -- a demand scenario always states its change; a promotion may state one (then it is a seller scenario).
  CHECK (kind <> 'closure' OR (scope = 'all' AND demand_change_pct IS NULL AND extra_delay_days IS NULL)),
  CHECK (kind <> 'supplier_delay' OR (scope = 'supplier' AND extra_delay_days IS NOT NULL AND demand_change_pct IS NULL)),
  CHECK (kind <> 'demand_scenario' OR (scope IN ('all', 'category', 'products') AND demand_change_pct IS NOT NULL AND extra_delay_days IS NULL)),
  CHECK (kind <> 'promotion' OR (scope IN ('all', 'category', 'products') AND extra_delay_days IS NULL))
);
CREATE INDEX calendar_entries_active ON calendar_entries (seller_id, start_date, end_date) WHERE status = 'active';

CREATE TABLE calendar_entry_events (
  id         SERIAL PRIMARY KEY,
  seller_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id   INT NOT NULL,
  event      VARCHAR(12) NOT NULL CHECK (event IN ('created', 'updated', 'cancelled')),
  before     JSONB,
  after      JSONB,
  actor      INT NOT NULL REFERENCES users(id),
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_entry_events_entry_fk FOREIGN KEY (entry_id, seller_id) REFERENCES calendar_entries (id, seller_id)
);
CREATE TRIGGER calendar_entry_events_append_only BEFORE UPDATE OR DELETE ON calendar_entry_events
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();

-- Declared slowest delivery for a product from a supplier (a planning scenario, not a prediction).
ALTER TABLE product_suppliers
  ADD COLUMN lead_time_max_days INT CHECK (lead_time_max_days BETWEEN 0 AND 365),
  ADD CONSTRAINT product_suppliers_lead_time_range_check
    CHECK (lead_time_max_days IS NULL OR (lead_time_days IS NOT NULL AND lead_time_max_days >= lead_time_days));
