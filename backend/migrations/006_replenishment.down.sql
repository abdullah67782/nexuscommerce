-- Reverses 006 ONLY while no recommendation, recommendation-linked order or new
-- setting exists. Otherwise it refuses and changes nothing. Preservation path:
-- restore the backup taken before migrating (docs/migration-runbook.md).
DO $$
DECLARE
  counts TEXT;
BEGIN
  SELECT format('recommendations=%s, orders created from a recommendation=%s, review-period/safety-stock settings=%s',
    (SELECT COUNT(*) FROM replenishment_recommendations),
    (SELECT COUNT(*) FROM purchase_orders WHERE source_recommendation_id IS NOT NULL),
    (SELECT COUNT(*) FROM inventory_policies WHERE review_period_days IS NOT NULL OR safety_stock_units IS NOT NULL))
  INTO counts;
  IF EXISTS (SELECT 1 FROM replenishment_recommendations)
     OR EXISTS (SELECT 1 FROM purchase_orders WHERE source_recommendation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM inventory_policies WHERE review_period_days IS NOT NULL OR safety_stock_units IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot reverse 006: replenishment data was recorded after the migration (%). Restore the pre-migration backup instead.', counts;
  END IF;
END $$;

DROP INDEX purchase_orders_one_per_recommendation;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_recommendation_fk;
ALTER TABLE purchase_orders DROP COLUMN source_recommendation_id;
DROP TABLE replenishment_recommendations;
ALTER TABLE inventory_policies DROP COLUMN safety_stock_units;
ALTER TABLE inventory_policies DROP COLUMN review_period_days;
