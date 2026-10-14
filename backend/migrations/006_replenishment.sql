-- 006 — Inventory Stage 2: replenishment recommendations (explainable, advisory).
--
-- Adds only:
--   * two seller settings on inventory_policies (review period, safety stock);
--   * an append-only log of computed recommendations (audit, stale detection for
--     drafts, later shadow evaluation — no evaluation is performed in Stage 2);
--   * an optional link from a DRAFT purchase order to the recommendation it came from.
-- No change to the stock ledger, the purchasing rules or any forecasting table.

-- Seller settings. NULL = not set: the engine then uses its documented defaults
-- (review period 7 days, labelled "default"; safety stock 0, disclosed).
ALTER TABLE inventory_policies
  ADD COLUMN review_period_days INT CHECK (review_period_days BETWEEN 1 AND 28),
  ADD COLUMN safety_stock_units INT CHECK (safety_stock_units >= 0);

CREATE TABLE replenishment_recommendations (
  id                  SERIAL PRIMARY KEY,
  seller_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id          INT NOT NULL,
  location_id         INT NOT NULL,
  planning_date       DATE NOT NULL,                 -- business date in the location's timezone
  engine_version      VARCHAR(40) NOT NULL,
  inputs_sha256       CHAR(64) NOT NULL,             -- canonical fingerprint of every input (incl. engine version)
  status              VARCHAR(20) NOT NULL CHECK (status IN ('needs_information', 'indicative', 'provisional')),
  actionable          BOOLEAN NOT NULL,
  suggested_quantity  INT CHECK (suggested_quantity >= 0),
  supplier_id         INT,
  models_release      VARCHAR(80),
  forecast_origin     DATE,
  inputs              JSONB NOT NULL,                -- the exact inputs the engine received
  output              JSONB NOT NULL,                -- the engine result as shown
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_id),
  -- Recomputing with identical inputs and the same engine adds nothing.
  CONSTRAINT replenishment_recommendations_identity_uq
    UNIQUE (seller_id, product_id, planning_date, engine_version, inputs_sha256),
  CONSTRAINT replenishment_recommendations_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id),
  CONSTRAINT replenishment_recommendations_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id),
  CONSTRAINT replenishment_recommendations_supplier_fk FOREIGN KEY (supplier_id, seller_id) REFERENCES suppliers (id, seller_id),
  CONSTRAINT replenishment_recommendations_actionable_check
    CHECK (NOT actionable OR (status = 'provisional' AND suggested_quantity > 0 AND supplier_id IS NOT NULL))
);
CREATE INDEX replenishment_recommendations_product ON replenishment_recommendations (seller_id, product_id, planning_date DESC);
CREATE TRIGGER replenishment_recommendations_append_only BEFORE UPDATE OR DELETE ON replenishment_recommendations
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();

-- A draft created from a recommendation remembers it. At most one LIVE (not cancelled)
-- order per recommendation: a retried or concurrent "create draft" returns the existing
-- order instead of a duplicate. Once that order is cancelled, the same recommendation
-- (identical inputs) may produce a new draft.
ALTER TABLE purchase_orders ADD COLUMN source_recommendation_id INT;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_recommendation_fk
  FOREIGN KEY (source_recommendation_id, seller_id) REFERENCES replenishment_recommendations (id, seller_id);
CREATE UNIQUE INDEX purchase_orders_one_per_recommendation
  ON purchase_orders (seller_id, source_recommendation_id)
  WHERE source_recommendation_id IS NOT NULL AND status <> 'cancelled';
