-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSED MIGRATION 002 — import identity, line identity and data coverage
--
-- STATUS: PROPOSAL FOR REVIEW. NOT APPLIED. Nothing loads this file:
-- config/initDb.js does not reference backend/migrations/. Rationale, API
-- contract and test plan: docs/import-identity-and-coverage.md.
--
-- Builds on what is already live (initDb.js steps 5-6): data_uploads is the
-- import record for files AND store-connect batches (source, idempotency_key,
-- payload_sha256, result_summary, unique (uploaded_by, idempotency_key)), and
-- the attributed_sales view.
--
-- Apply only after: pg_dump backup, ownership repair reviewed (or explicitly
-- deferred), and the matching code release (upload + store-connect paths).
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Store connections (who/where an API import comes from) ──────────────
CREATE TABLE store_connections (
  id                 SERIAL PRIMARY KEY,
  seller_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           VARCHAR(50)  NOT NULL,           -- e.g. 'manual_api', 'shopify'
  external_store_id  VARCHAR(255) NOT NULL,           -- the store's id at the provider
  display_name       VARCHAR(255),
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, provider, external_store_id)
);

-- ── 2. Import records: connection link, file identity ──────────────────────
ALTER TABLE data_uploads ADD COLUMN connection_id INT REFERENCES store_connections(id) ON DELETE RESTRICT;
ALTER TABLE data_uploads ADD COLUMN file_sha256   CHAR(64);             -- files: hash of the uploaded bytes
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_source_check
  CHECK (source IN ('file_upload', 'store_connect', 'seed'));
-- File replays reuse the existing idempotency index: key = 'file:' || file_sha256.
-- Rolling an import back RELEASES its identity (idempotency_key := NULL) so the
-- same file / import_id can be imported again deliberately.

-- ── 3. Line identity on sales ──────────────────────────────────────────────
ALTER TABLE sales ADD COLUMN connection_id      INT REFERENCES store_connections(id) ON DELETE RESTRICT;
ALTER TABLE sales ADD COLUMN source_line_id     VARCHAR(255);   -- API: stable line/transaction id (NOT order id)
ALTER TABLE sales ADD COLUMN source_row_number  INT;            -- files / API without ids: position in the import
ALTER TABLE sales ADD COLUMN superseded_by_upload_id INT REFERENCES data_uploads(id) ON DELETE SET NULL;

-- An external line can exist once per connection, whichever batch delivers it.
CREATE UNIQUE INDEX sales_connection_line_uq
  ON sales (connection_id, source_line_id)
  WHERE source_line_id IS NOT NULL;
-- Within one import every row is distinct, so identical genuine rows are kept.
CREATE UNIQUE INDEX sales_import_row_uq
  ON sales (upload_id, source_row_number)
  WHERE source_row_number IS NOT NULL;

-- The legacy rule merged genuine identical orders and let NULL revenue through.
-- Dropped in the same release that switches both import paths to line identity.
-- Existing rows are untouched (they were deduplicated under the old rule).
ALTER TABLE sales DROP CONSTRAINT IF EXISTS unique_sale_transaction;

-- ── 4. Data coverage (seller-confirmed complete periods) ───────────────────
CREATE TABLE data_coverage (
  id               SERIAL PRIMARY KEY,
  seller_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_id        INT REFERENCES data_uploads(id) ON DELETE CASCADE,
  connection_id    INT REFERENCES store_connections(id) ON DELETE CASCADE,
  observed_start   DATE,                        -- first/last transaction date: informational only
  observed_end     DATE,
  declared_start   DATE,                        -- period confirmed complete
  declared_end     DATE,
  scope            VARCHAR(16) NOT NULL DEFAULT 'all_products'
                   CHECK (scope IN ('all_products', 'listed_products')),
  status           VARCHAR(12) NOT NULL DEFAULT 'unconfirmed'
                   CHECK (status IN ('unconfirmed', 'confirmed', 'revoked')),
  evidence         VARCHAR(30)
                   CHECK (evidence IN ('seller_declaration', 'connector_full_export')),
  evidence_note    TEXT,
  declared_by      INT REFERENCES users(id),
  declared_at      TIMESTAMP,
  revoked_by       INT REFERENCES users(id),
  revoked_at       TIMESTAMP,
  revoke_reason    VARCHAR(30) CHECK (revoke_reason IN ('rollback', 'seller_revoked', 'superseded')),
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (upload_id IS NOT NULL OR connection_id IS NOT NULL),
  CHECK (status <> 'confirmed' OR (declared_start IS NOT NULL AND declared_end IS NOT NULL
                                   AND declared_start <= declared_end AND evidence IS NOT NULL
                                   AND declared_by IS NOT NULL AND declared_at IS NOT NULL)),
  CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX data_coverage_seller_status ON data_coverage (seller_id, status);

CREATE TABLE data_coverage_products (           -- only for scope = 'listed_products'
  coverage_id INT NOT NULL REFERENCES data_coverage(id) ON DELETE CASCADE,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (coverage_id, product_id)
);

-- Existing imports: unconfirmed, with their observed range only.
INSERT INTO data_coverage (seller_id, upload_id, observed_start, observed_end, status)
SELECT du.uploaded_by, du.id, MIN(s.sale_date), MAX(s.sale_date), 'unconfirmed'
FROM data_uploads du
JOIN sales s ON s.upload_id = du.id
WHERE du.uploaded_by IS NOT NULL
GROUP BY du.uploaded_by, du.id;

-- ── 5. attributed_sales also hides superseded rows ─────────────────────────
CREATE OR REPLACE VIEW attributed_sales AS
SELECT s.id, s.product_id, s.quantity, s.sale_date, s.revenue, s.upload_id, s.created_at,
       p.user_id AS seller_id
FROM sales s
JOIN products p ON p.id = s.product_id
LEFT JOIN data_uploads du ON du.id = s.upload_id
WHERE p.user_id IS NOT NULL
  AND (s.upload_id IS NULL OR du.uploaded_by = p.user_id)
  AND s.superseded_by_upload_id IS NULL;

-- ── 6. Version numbers cannot collide under concurrent imports ─────────────
-- (Import transactions also take pg_advisory_xact_lock(seller_id).)
ALTER TABLE upload_versions ADD CONSTRAINT upload_versions_seller_version_uq UNIQUE (seller_id, version_number);

COMMIT;

-- ── DOWN (manual) ───────────────────────────────────────────────────────────
-- Re-adding unique_sale_transaction fails once identical genuine rows exist.
-- Preferred rollback: restore the pg_dump taken before applying. Otherwise:
--   BEGIN;
--   CREATE OR REPLACE VIEW attributed_sales AS <definition from initDb.js step 6>;
--   ALTER TABLE upload_versions DROP CONSTRAINT upload_versions_seller_version_uq;
--   DROP TABLE data_coverage_products, data_coverage;
--   DROP INDEX sales_import_row_uq, sales_connection_line_uq;
--   ALTER TABLE sales DROP COLUMN superseded_by_upload_id, DROP COLUMN source_row_number,
--                     DROP COLUMN source_line_id, DROP COLUMN connection_id;
--   ALTER TABLE data_uploads DROP CONSTRAINT data_uploads_source_check,
--                            DROP COLUMN file_sha256, DROP COLUMN connection_id;
--   DROP TABLE store_connections;
--   -- only after removing duplicates:
--   ALTER TABLE sales ADD CONSTRAINT unique_sale_transaction UNIQUE (product_id, sale_date, quantity, revenue);
--   COMMIT;
