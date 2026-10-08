-- 004: inventory ledger — Stage 1a of Inventory AI (docs/inventory-stage1-plan.md).
--
-- Stock is never stored as one editable number. Physical on-hand at a location is
--   latest selected count + Σ movements effective strictly after that count
-- and is computed when read (backend/lib/stockLedger.js).
--   * counts (stock_snapshots) are absolute measurements at an instant;
--   * movements are signed physical deltas with their own identity;
--   * a count INCLUDES every event effective at or before its instant;
--   * only verified counts with a measurement time can be the baseline —
--     unverified legacy values are shown, never used for arithmetic;
--   * two active counts of the same product/location/instant cannot exist:
--     a different value needs explicit supersession, never insertion order.
-- Sales imports never write stock. The legacy `inventory` table is kept intact
-- (read-only from now on) and fully copied into inventory_legacy_rows.

-- ── Locations (one default per seller in Stage 1) ───────────────────────────
CREATE TABLE inventory_locations (
  id          SERIAL PRIMARY KEY,
  seller_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL DEFAULT 'Main location',
  timezone    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Karachi',
  is_default  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_id)
);
CREATE UNIQUE INDEX inventory_locations_one_default ON inventory_locations (seller_id) WHERE is_default;

-- ── Which sources may report physical stock / shipments, and for which location ─
-- A connector's channel "available" quantity is not physical on-hand: a source
-- can submit counts only after it is mapped as reporting physical on-hand.
CREATE TABLE inventory_source_mappings (
  id                   SERIAL PRIMARY KEY,
  seller_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id            INT NOT NULL,
  location_id          INT NOT NULL,
  reports_physical_on_hand BOOLEAN NOT NULL DEFAULT FALSE,
  -- The source sends EVERY shipment/return event for this location from this instant.
  shipment_feed_since  TIMESTAMPTZ,
  updated_by           INT REFERENCES users(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, source_id),
  CONSTRAINT inventory_source_mappings_source_fk FOREIGN KEY (source_id, seller_id) REFERENCES data_sources (id, seller_id),
  CONSTRAINT inventory_source_mappings_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id)
);

-- Stock-count files are import versions (rollback like any import).
ALTER TABLE data_uploads DROP CONSTRAINT data_uploads_source_kind_check;
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_source_kind_check
  CHECK (source IN ('file_upload', 'store_connect', 'stock_count'));

-- ── Count submissions (identity, provenance, revocation) ────────────────────
CREATE TABLE stock_snapshot_batches (
  id               SERIAL PRIMARY KEY,
  seller_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key  VARCHAR(220) NOT NULL,
  content_sha256   CHAR(64) NOT NULL,
  source_kind      VARCHAR(20) NOT NULL
                   CHECK (source_kind IN ('manual_count', 'count_file', 'connector', 'legacy_migration')),
  source_id        INT,
  upload_id        INT,
  location_id      INT NOT NULL,
  observed_at      TIMESTAMPTZ,                      -- NULL only for legacy_migration
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by      INT REFERENCES users(id),
  status           VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at       TIMESTAMPTZ,
  revoked_by       INT REFERENCES users(id),
  revoke_reason    VARCHAR(30) CHECK (revoke_reason IN ('rollback', 'seller_revoked')),
  result_summary   JSONB,
  UNIQUE (seller_id, idempotency_key),
  UNIQUE (id, seller_id),
  CONSTRAINT stock_snapshot_batches_source_fk FOREIGN KEY (source_id, seller_id) REFERENCES data_sources (id, seller_id),
  CONSTRAINT stock_snapshot_batches_upload_fk FOREIGN KEY (upload_id, seller_id) REFERENCES data_uploads (id, uploaded_by),
  CONSTRAINT stock_snapshot_batches_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id),
  CHECK ((source_kind = 'legacy_migration') = (observed_at IS NULL)),
  CHECK (source_kind <> 'connector' OR source_id IS NOT NULL),
  CHECK (source_kind <> 'count_file' OR upload_id IS NOT NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE TABLE stock_snapshots (
  id              SERIAL PRIMARY KEY,
  seller_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id        INT NOT NULL,
  product_id      INT NOT NULL,
  location_id     INT NOT NULL,
  quantity        INT NOT NULL CHECK (quantity >= 0),
  observed_at     TIMESTAMPTZ,
  verification    VARCHAR(10) NOT NULL CHECK (verification IN ('verified', 'unverified')),
  status          VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  superseded_by   INT REFERENCES stock_snapshots(id) DEFERRABLE INITIALLY DEFERRED,
  legacy_row_id   INT,                               -- inventory.id for legacy rows
  legacy_recorded_at TIMESTAMP,                      -- inventory.updated_at (a write time, not a count time)
  UNIQUE (batch_id, product_id, location_id),        -- one item per product/location per submission
  CONSTRAINT stock_snapshots_batch_fk FOREIGN KEY (batch_id, seller_id) REFERENCES stock_snapshot_batches (id, seller_id),
  CONSTRAINT stock_snapshots_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id),
  CONSTRAINT stock_snapshots_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id),
  CHECK ((verification = 'unverified') = (observed_at IS NULL)),
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
);
-- Physical truth is never decided by insertion order.
CREATE UNIQUE INDEX stock_snapshots_one_active_per_instant
  ON stock_snapshots (seller_id, product_id, location_id, observed_at)
  WHERE status = 'active' AND observed_at IS NOT NULL;
CREATE INDEX stock_snapshots_lookup ON stock_snapshots (seller_id, product_id, location_id, status, observed_at);

-- ── Movements: signed physical deltas, append-only ──────────────────────────
CREATE TABLE stock_movements (
  id                 SERIAL PRIMARY KEY,
  seller_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id         INT NOT NULL,
  location_id        INT NOT NULL,
  kind               VARCHAR(20) NOT NULL
                     CHECK (kind IN ('shipment', 'customer_return', 'damage', 'found', 'correction')),
  quantity           INT NOT NULL CHECK (quantity <> 0),
  effective_at       TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_id          INT,                            -- connector events
  external_event_id  VARCHAR(255),
  order_ref          VARCHAR(255),
  idempotency_key    VARCHAR(220),                   -- manual entries
  content_sha256     CHAR(64) NOT NULL,
  reason             TEXT,
  created_by         INT REFERENCES users(id),
  CONSTRAINT stock_movements_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id),
  CONSTRAINT stock_movements_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id),
  CONSTRAINT stock_movements_source_fk FOREIGN KEY (source_id, seller_id) REFERENCES data_sources (id, seller_id),
  CHECK (CASE kind WHEN 'shipment' THEN quantity < 0
                   WHEN 'damage' THEN quantity < 0
                   WHEN 'customer_return' THEN quantity > 0
                   WHEN 'found' THEN quantity > 0
                   ELSE TRUE END),
  CHECK (external_event_id IS NOT NULL OR idempotency_key IS NOT NULL),
  CHECK (external_event_id IS NULL OR source_id IS NOT NULL),
  CHECK (kind IN ('shipment', 'customer_return') OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX stock_movements_event_uq ON stock_movements (seller_id, source_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_idempotency_uq ON stock_movements (seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_movements_lookup ON stock_movements (seller_id, product_id, location_id, effective_at);

-- ── Manual settings (no AI here) ────────────────────────────────────────────
CREATE TABLE inventory_policies (
  id                 SERIAL PRIMARY KEY,
  seller_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id         INT,                            -- NULL = seller default for the location
  location_id        INT NOT NULL,
  reorder_threshold  INT CHECK (reorder_threshold >= 0),
  stale_after_days   INT CHECK (stale_after_days BETWEEN 1 AND 365),
  provenance         VARCHAR(20) NOT NULL CHECK (provenance IN ('seller', 'legacy_migration')),
  updated_by         INT REFERENCES users(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_policies_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id),
  CONSTRAINT inventory_policies_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id)
);
-- A plain UNIQUE would not stop several NULL-product (default) rows.
CREATE UNIQUE INDEX inventory_policies_default_uq ON inventory_policies (seller_id, location_id) WHERE product_id IS NULL;
CREATE UNIQUE INDEX inventory_policies_product_uq ON inventory_policies (seller_id, product_id, location_id) WHERE product_id IS NOT NULL;

-- ── Legacy evidence: every original inventory row and what became of it ─────
CREATE TABLE inventory_legacy_rows (
  inventory_id       INT PRIMARY KEY,
  product_id         INT,
  owner_id           INT,
  stock_level        INT,
  reorder_threshold  INT,
  updated_at         TIMESTAMP,
  outcome            VARCHAR(30) NOT NULL CHECK (outcome IN
                     ('migrated', 'duplicate_not_selected', 'ownerless_not_migrated',
                      'missing_product', 'negative_not_migrated')),
  snapshot_id        INT REFERENCES stock_snapshots(id),
  migrated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Backfill ────────────────────────────────────────────────────────────────
INSERT INTO inventory_locations (seller_id)
SELECT DISTINCT user_id FROM products WHERE user_id IS NOT NULL;

CREATE TEMP TABLE _legacy ON COMMIT DROP AS
SELECT i.id AS inventory_id, i.product_id, p.user_id AS owner_id, i.stock_level, i.reorder_threshold, i.updated_at,
       ROW_NUMBER() OVER (PARTITION BY i.product_id ORDER BY i.updated_at DESC NULLS LAST, i.id DESC) AS rank,
       (p.id IS NULL) AS missing_product
FROM inventory i LEFT JOIN products p ON p.id = i.product_id;

INSERT INTO inventory_legacy_rows (inventory_id, product_id, owner_id, stock_level, reorder_threshold, updated_at, outcome)
SELECT inventory_id, product_id, owner_id, stock_level, reorder_threshold, updated_at,
       CASE WHEN missing_product THEN 'missing_product'
            WHEN owner_id IS NULL THEN 'ownerless_not_migrated'
            WHEN rank > 1 THEN 'duplicate_not_selected'
            WHEN stock_level < 0 THEN 'negative_not_migrated'
            ELSE 'migrated' END
FROM _legacy;

INSERT INTO stock_snapshot_batches (seller_id, idempotency_key, content_sha256, source_kind, location_id, observed_at, result_summary)
SELECT l.owner_id, 'legacy-migration-004', repeat('0', 64), 'legacy_migration', loc.id, NULL,
       jsonb_build_object('note', 'Values copied from the legacy inventory table. updated_at is a write time, not a count time.')
FROM (SELECT DISTINCT owner_id FROM inventory_legacy_rows WHERE outcome = 'migrated') l
JOIN inventory_locations loc ON loc.seller_id = l.owner_id AND loc.is_default;

INSERT INTO stock_snapshots (seller_id, batch_id, product_id, location_id, quantity, observed_at, verification,
                             legacy_row_id, legacy_recorded_at)
SELECT r.owner_id, b.id, r.product_id, b.location_id, r.stock_level, NULL, 'unverified', r.inventory_id, r.updated_at
FROM inventory_legacy_rows r
JOIN stock_snapshot_batches b ON b.seller_id = r.owner_id AND b.source_kind = 'legacy_migration'
WHERE r.outcome = 'migrated';

UPDATE inventory_legacy_rows r SET snapshot_id = s.id
FROM stock_snapshots s WHERE s.legacy_row_id = r.inventory_id;

INSERT INTO inventory_policies (seller_id, product_id, location_id, reorder_threshold, provenance)
SELECT r.owner_id, r.product_id, b.location_id, r.reorder_threshold, 'legacy_migration'
FROM inventory_legacy_rows r
JOIN stock_snapshot_batches b ON b.seller_id = r.owner_id AND b.source_kind = 'legacy_migration'
WHERE r.outcome = 'migrated' AND r.reorder_threshold IS NOT NULL;
