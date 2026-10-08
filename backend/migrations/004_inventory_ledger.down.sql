-- Reverses 004 ONLY while it holds nothing but the migrated legacy values.
-- Inventory recorded after 004 (counts, movements, seller settings, source
-- mappings, stock-count imports) is never discarded silently: the reversal
-- refuses and changes nothing. Preservation path: restore the backup taken
-- before migrating (docs/migration-runbook.md), or export these tables first.
-- The legacy `inventory` table was never modified by 004, so after reversal it
-- holds exactly the values it had before.
DO $$
DECLARE
  counts TEXT;
BEGIN
  SELECT format('counts=%s, movements=%s, seller settings=%s, source mappings=%s, stock-count imports=%s',
    (SELECT COUNT(*) FROM stock_snapshot_batches WHERE source_kind <> 'legacy_migration'),
    (SELECT COUNT(*) FROM stock_movements),
    (SELECT COUNT(*) FROM inventory_policies WHERE provenance <> 'legacy_migration'),
    (SELECT COUNT(*) FROM inventory_source_mappings),
    (SELECT COUNT(*) FROM data_uploads WHERE source = 'stock_count'))
  INTO counts;
  IF EXISTS (SELECT 1 FROM stock_snapshot_batches WHERE source_kind <> 'legacy_migration')
     OR EXISTS (SELECT 1 FROM stock_movements)
     OR EXISTS (SELECT 1 FROM inventory_policies WHERE provenance <> 'legacy_migration')
     OR EXISTS (SELECT 1 FROM inventory_source_mappings)
     OR EXISTS (SELECT 1 FROM data_uploads WHERE source = 'stock_count') THEN
    RAISE EXCEPTION 'cannot reverse 004: inventory was recorded after the migration (%). Restore the pre-migration backup or export these tables first.', counts;
  END IF;
END $$;

DROP TABLE inventory_legacy_rows;
DROP TABLE inventory_policies;
DROP TABLE stock_movements;
DROP TABLE stock_snapshots;
DROP TABLE stock_snapshot_batches;
DROP TABLE inventory_source_mappings;
DROP TABLE inventory_locations;
ALTER TABLE data_uploads DROP CONSTRAINT data_uploads_source_kind_check;
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_source_kind_check
  CHECK (source IN ('file_upload', 'store_connect'));
