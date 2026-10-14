-- 008 — Forecast upper estimates (upper-estimates-1): the seller's applicability answers only.
--
-- The upper estimates themselves are computed on request and never stored. This migration records what the
-- applicability policy (upper-estimates-policy-1) needs from the seller, because a country or timezone alone
-- does not establish that US Walmart benchmark evidence applies to a store:
--   * upper_estimate_settings: the seller's confirmation that the store matches the benchmark profile
--     ('us_general_retail': a US store selling individual units of food, household or hobby products) and that
--     the estimates are a benchmark reference, not calibrated to the store; it can be withdrawn;
--   * upper_estimate_product_types: per product, the benchmark department the seller says it belongs to
--     ('foods', 'household', 'hobbies') or 'not_covered';
--   * upper_estimate_events: append-only history of both.
-- No change to products, sales, forecasts, stock, orders, calendars or recommendations.

CREATE TABLE upper_estimate_settings (
  seller_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile         VARCHAR(30) NOT NULL CHECK (profile IN ('us_general_retail')),
  status          VARCHAR(10) NOT NULL CHECK (status IN ('confirmed', 'withdrawn')),
  policy_version  VARCHAR(40) NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]+$'),
  updated_by      INT NOT NULL REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version         INT NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE upper_estimate_product_types (
  seller_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INT NOT NULL,
  department  VARCHAR(12) NOT NULL CHECK (department IN ('foods', 'household', 'hobbies', 'not_covered')),
  updated_by  INT NOT NULL REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (seller_id, product_id),
  CONSTRAINT upper_estimate_product_types_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id) ON DELETE CASCADE
);

CREATE TABLE upper_estimate_events (
  id          SERIAL PRIMARY KEY,
  seller_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  INT,
  event       VARCHAR(20) NOT NULL CHECK (event IN ('profile_confirmed', 'profile_withdrawn', 'product_type_set')),
  before      JSONB,
  after       JSONB NOT NULL,
  actor       INT NOT NULL REFERENCES users(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((event = 'product_type_set') = (product_id IS NOT NULL))
);
CREATE INDEX upper_estimate_events_seller ON upper_estimate_events (seller_id, id);
CREATE TRIGGER upper_estimate_events_append_only BEFORE UPDATE OR DELETE ON upper_estimate_events
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();
