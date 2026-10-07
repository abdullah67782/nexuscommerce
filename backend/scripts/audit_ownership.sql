-- Read-only audit for data written before seller isolation was enforced.
-- Run against the development database:  psql -d nexuscommerce -f scripts/audit_ownership.sql
-- It changes nothing. Review the results before deciding on any data repair.

-- 1. Products with no owner, and how many sales rows they hold.
--    These are now invisible to every seller (e.g. rows from the old seeder).
SELECT p.id, p.name, COUNT(s.id) AS sales_rows
FROM products p
LEFT JOIN sales s ON s.product_id = p.id
WHERE p.user_id IS NULL
GROUP BY p.id, p.name
ORDER BY sales_rows DESC;

-- 2. Sales imported by one seller but attached to a product owned by someone
--    else (or by no one). Before the fix, uploads matched products by name only.
SELECT du.uploaded_by AS uploading_seller,
       p.user_id      AS product_owner,
       p.id           AS product_id,
       p.name,
       COUNT(*)       AS sales_rows
FROM sales s
JOIN data_uploads du ON du.id = s.upload_id
JOIN products p      ON p.id = s.product_id
WHERE p.user_id IS DISTINCT FROM du.uploaded_by
GROUP BY du.uploaded_by, p.user_id, p.id, p.name
ORDER BY sales_rows DESC;

-- 3. Stored forecasts with no seller (excluded from forecast-vs-actual now).
SELECT COUNT(*) AS forecasts_without_seller FROM forecasts WHERE seller_id IS NULL;
