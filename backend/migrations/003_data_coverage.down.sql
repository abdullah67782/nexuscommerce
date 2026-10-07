-- Reverses 003. Sales, products and imports are untouched; coverage
-- declarations are removed, so days without rows become unknown again.
-- The view must be dropped (not replaced) to remove its added column.
DROP VIEW attributed_sales;
CREATE VIEW attributed_sales AS
SELECT s.id, s.product_id, s.quantity, s.sale_date, s.revenue, s.upload_id, s.created_at,
       p.user_id AS seller_id
FROM sales s
JOIN products p ON p.id = s.product_id
LEFT JOIN data_uploads du ON du.id = s.upload_id
WHERE p.user_id IS NOT NULL
  AND (s.upload_id IS NULL OR du.uploaded_by = p.user_id);
DROP TABLE data_coverage_products;
DROP TABLE data_coverage;
ALTER TABLE products     DROP CONSTRAINT products_id_owner_uq;
ALTER TABLE data_uploads DROP CONSTRAINT data_uploads_id_seller_uq;
