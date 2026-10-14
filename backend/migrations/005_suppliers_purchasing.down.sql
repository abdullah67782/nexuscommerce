-- Reverses 005 ONLY while no supplier, purchase order or purchasing movement
-- exists. Purchasing data is never discarded silently: otherwise the reversal
-- refuses and changes nothing. Preservation path: restore the backup taken before
-- migrating (docs/migration-runbook.md), or export these tables first.
DO $$
DECLARE
  counts TEXT;
BEGIN
  SELECT format('suppliers=%s, product-supplier links=%s, purchase orders=%s, receipts=%s, purchasing movements=%s',
    (SELECT COUNT(*) FROM suppliers), (SELECT COUNT(*) FROM product_suppliers),
    (SELECT COUNT(*) FROM purchase_orders), (SELECT COUNT(*) FROM purchase_receipts),
    (SELECT COUNT(*) FROM stock_movements WHERE kind IN ('receipt', 'receipt_correction', 'supplier_return')))
  INTO counts;
  IF EXISTS (SELECT 1 FROM suppliers) OR EXISTS (SELECT 1 FROM product_suppliers)
     OR EXISTS (SELECT 1 FROM purchase_orders) OR EXISTS (SELECT 1 FROM purchase_receipts)
     OR EXISTS (SELECT 1 FROM stock_movements WHERE kind IN ('receipt', 'receipt_correction', 'supplier_return')) THEN
    RAISE EXCEPTION 'cannot reverse 005: purchasing data was recorded after the migration (%). Restore the pre-migration backup or export these tables first.', counts;
  END IF;
END $$;

DROP VIEW purchase_order_line_quantities;
DROP INDEX stock_movements_one_per_adjustment;
DROP INDEX stock_movements_one_per_receipt_line;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_adjustment_link_check;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_receipt_link_check;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_check3
  CHECK (kind IN ('shipment', 'customer_return') OR reason IS NOT NULL);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_sign_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_check CHECK (CASE kind
  WHEN 'shipment' THEN quantity < 0 WHEN 'damage' THEN quantity < 0
  WHEN 'customer_return' THEN quantity > 0 WHEN 'found' THEN quantity > 0
  ELSE TRUE END);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
  CHECK (kind IN ('shipment', 'customer_return', 'damage', 'found', 'correction'));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_receipt_adjustment_fk;
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_receipt_line_fk;
ALTER TABLE stock_movements DROP COLUMN receipt_adjustment_id;
ALTER TABLE stock_movements DROP COLUMN receipt_line_id;

DROP TABLE purchase_order_events;
DROP TABLE purchase_receipt_adjustments;
DROP TABLE purchase_receipt_lines;
DROP TABLE purchase_receipts;
DROP TABLE purchase_order_lines;
DROP TABLE purchase_orders;
DROP TABLE product_suppliers;
DROP TABLE suppliers;
DROP FUNCTION purchasing_append_only();
