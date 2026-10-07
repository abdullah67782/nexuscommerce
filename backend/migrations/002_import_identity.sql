-- ════════════════════════════════════════════════════════════════════════════
-- 002 IMPORT IDENTITY — data sources, stable batch and line identity,
-- per-seller ownership consistency.
--
-- Replaces the legacy sale-content uniqueness rule (unique_sale_transaction),
-- which merged genuine identical orders and let NULL-revenue retries through.
-- Duplicate prevention after this migration:
--   batch  : data_uploads (uploaded_by, idempotency_key)        [exists since 001]
--   line   : sales (source_id, source_line_id)  when a line id is supplied
--   row    : sales (upload_id, source_row_number) within one import
-- Overlap between imports without line ids is detected by the application
-- (rejected unless the import says overlap_mode = 'append').
--
-- Reversal: 002_import_identity.down.sql (refuses if genuine identical rows now
-- exist). Preferred rollback is restoring the backup taken before applying.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Data sources: where an import comes from ─────────────────────────────
-- One 'file' source per seller for file uploads, one 'api' source per connected
-- store. Overlap checks and (later) coverage apply within a single source only.
CREATE TABLE data_sources (
  id            SERIAL PRIMARY KEY,
  seller_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          VARCHAR(8)   NOT NULL CHECK (kind IN ('file', 'api')),
  provider      VARCHAR(50)  NOT NULL,
  external_id   VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255),
  -- IANA zone in which this source's sale dates are business-local dates.
  timezone      VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, kind, provider, external_id),
  UNIQUE (id, seller_id)                       -- target of composite ownership FKs
);

-- ── 2. Import records ───────────────────────────────────────────────────────
ALTER TABLE data_uploads ADD COLUMN source_id      INT;
ALTER TABLE data_uploads ADD COLUMN content_sha256 CHAR(64);   -- fingerprint of the content (file bytes / payload)
ALTER TABLE data_uploads ADD COLUMN overlap_mode   VARCHAR(8) CHECK (overlap_mode IN ('reject', 'append'));
ALTER TABLE data_uploads ADD COLUMN status         VARCHAR(12) NOT NULL DEFAULT 'committed'
  CHECK (status IN ('committed', 'rolled_back'));
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_source_kind_check
  CHECK (source IN ('file_upload', 'store_connect'));

-- Backfill one default source per seller and kind that has imports.
INSERT INTO data_sources (seller_id, kind, provider, external_id, display_name)
SELECT DISTINCT uploaded_by, 'file', 'file_upload', 'default', 'File uploads'
FROM data_uploads WHERE uploaded_by IS NOT NULL AND source = 'file_upload';
INSERT INTO data_sources (seller_id, kind, provider, external_id, display_name)
SELECT DISTINCT uploaded_by, 'api', 'manual_api', 'default', 'Store connection'
FROM data_uploads WHERE uploaded_by IS NOT NULL AND source = 'store_connect';

UPDATE data_uploads du SET source_id = ds.id
FROM data_sources ds
WHERE ds.seller_id = du.uploaded_by
  AND ds.external_id = 'default'
  AND ((du.source = 'file_upload'   AND ds.kind = 'file')
    OR (du.source = 'store_connect' AND ds.kind = 'api'));

UPDATE data_uploads SET content_sha256 = payload_sha256 WHERE payload_sha256 IS NOT NULL;
UPDATE data_uploads du SET status = 'rolled_back'
FROM upload_versions uv WHERE uv.upload_id = du.id AND uv.is_rolled_back;

-- An import's source must belong to the same seller (composite FK).
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_source_owner_fk
  FOREIGN KEY (source_id, uploaded_by) REFERENCES data_sources (id, seller_id);

-- ── 3. Line and row identity on sales ───────────────────────────────────────
ALTER TABLE sales ADD COLUMN source_id         INT REFERENCES data_sources(id);
ALTER TABLE sales ADD COLUMN source_line_id    VARCHAR(255);
ALTER TABLE sales ADD COLUMN source_row_number INT CHECK (source_row_number > 0);

UPDATE sales s SET source_id = du.source_id
FROM data_uploads du WHERE du.id = s.upload_id AND du.source_id IS NOT NULL;

CREATE UNIQUE INDEX sales_source_line_uq
  ON sales (source_id, source_line_id) WHERE source_line_id IS NOT NULL;
CREATE UNIQUE INDEX sales_import_row_uq
  ON sales (upload_id, source_row_number) WHERE source_row_number IS NOT NULL;
CREATE INDEX sales_source_product_date_idx ON sales (source_id, product_id, sale_date);

-- Legacy content rule goes. Existing rows are untouched.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS unique_sale_transaction;

-- ── 4. Version numbers are unique per seller ────────────────────────────────
-- (Imports and rollbacks also hold a per-seller advisory lock in the application.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM upload_versions GROUP BY seller_id, version_number HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'upload_versions has duplicate (seller_id, version_number) pairs; resolve them before applying 002';
  END IF;
END $$;
ALTER TABLE upload_versions ADD CONSTRAINT upload_versions_seller_version_uq UNIQUE (seller_id, version_number);

-- ── 5. Ownership consistency for new writes ─────────────────────────────────
-- Existing quarantined rows (see attributed_sales) are not re-checked; any NEW
-- or CHANGED row must agree: import seller = product owner, and the row's
-- source = its import's source.
CREATE FUNCTION nexus_check_sale_provenance() RETURNS trigger AS $$
DECLARE
  importer INT; import_source INT; owner INT;
BEGIN
  IF NEW.upload_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT uploaded_by, source_id INTO importer, import_source FROM data_uploads WHERE id = NEW.upload_id;
  SELECT user_id INTO owner FROM products WHERE id = NEW.product_id;
  IF importer IS DISTINCT FROM owner THEN
    RAISE EXCEPTION 'sale provenance: import % belongs to seller %, product % to seller %',
      NEW.upload_id, importer, NEW.product_id, owner USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_id IS DISTINCT FROM import_source THEN
    RAISE EXCEPTION 'sale provenance: row source % differs from import source %', NEW.source_id, import_source
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER sales_provenance_check
  BEFORE INSERT OR UPDATE OF product_id, upload_id, source_id ON sales
  FOR EACH ROW EXECUTE FUNCTION nexus_check_sale_provenance();

CREATE FUNCTION nexus_check_product_provenance() RETURNS trigger AS $$
DECLARE
  importer INT;
BEGIN
  IF NEW.upload_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT uploaded_by INTO importer FROM data_uploads WHERE id = NEW.upload_id;
  IF importer IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'product provenance: import % belongs to seller %, product owner is %',
      NEW.upload_id, importer, NEW.user_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER products_provenance_check
  BEFORE INSERT OR UPDATE OF user_id, upload_id ON products
  FOR EACH ROW EXECUTE FUNCTION nexus_check_product_provenance();
