-- ════════════════════════════════════════════════════════════════════════════
-- Reverse 002 IMPORT IDENTITY. Run only via:  node db/migrate.js down 2
-- Take a backup first. Preferred rollback is restoring the pre-002 backup.
--
-- Loses: data sources, line ids, row numbers, import status and fingerprints.
-- Keeps: every sale, product and import record.
-- Refuses (and changes nothing) if sales now contain rows the legacy rule
-- (product, date, quantity, revenue) would reject — e.g. genuine identical
-- orders imported after 002. Those must be resolved by restoring the backup.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  clashes INT;
BEGIN
  SELECT COUNT(*) INTO clashes FROM (
    SELECT 1 FROM sales
    WHERE revenue IS NOT NULL
    GROUP BY product_id, sale_date, quantity, revenue
    HAVING COUNT(*) > 1
  ) d;
  IF clashes > 0 THEN
    RAISE EXCEPTION 'cannot reverse 002: % groups of identical sales would violate the legacy rule; restore the pre-002 backup instead', clashes;
  END IF;
END $$;

DROP TRIGGER IF EXISTS products_provenance_check ON products;
DROP TRIGGER IF EXISTS sales_provenance_check ON sales;
DROP FUNCTION IF EXISTS nexus_check_product_provenance();
DROP FUNCTION IF EXISTS nexus_check_sale_provenance();

ALTER TABLE upload_versions DROP CONSTRAINT IF EXISTS upload_versions_seller_version_uq;

DROP INDEX IF EXISTS sales_source_product_date_idx;
DROP INDEX IF EXISTS sales_import_row_uq;
DROP INDEX IF EXISTS sales_source_line_uq;
ALTER TABLE sales DROP COLUMN IF EXISTS source_row_number;
ALTER TABLE sales DROP COLUMN IF EXISTS source_line_id;
ALTER TABLE sales DROP COLUMN IF EXISTS source_id;
ALTER TABLE sales ADD CONSTRAINT unique_sale_transaction UNIQUE (product_id, sale_date, quantity, revenue);

ALTER TABLE data_uploads DROP CONSTRAINT IF EXISTS data_uploads_source_owner_fk;
ALTER TABLE data_uploads DROP CONSTRAINT IF EXISTS data_uploads_source_kind_check;
ALTER TABLE data_uploads DROP COLUMN IF EXISTS status;
ALTER TABLE data_uploads DROP COLUMN IF EXISTS overlap_mode;
ALTER TABLE data_uploads DROP COLUMN IF EXISTS content_sha256;
ALTER TABLE data_uploads DROP COLUMN IF EXISTS source_id;

DROP TABLE IF EXISTS data_sources;
