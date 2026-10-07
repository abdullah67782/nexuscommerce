-- ════════════════════════════════════════════════════════════════════════════
-- Ownership repair — READ-ONLY inventory and dry-run mapping
--
-- Lists sales written before seller isolation whose import provenance disagrees
-- with the product's owner, proposes where each group of rows would go, and
-- lists everything that is ambiguous or derived from the affected data.
-- It changes NOTHING: the whole script runs inside a READ ONLY transaction that
-- is rolled back at the end. See docs/ownership-repair-plan.md.
--
--   psql -d nexuscommerce -f backend/scripts/ownership_repair_dryrun.sql
-- To keep the results:   add  -o repair_dryrun_<date>.txt
-- ════════════════════════════════════════════════════════════════════════════
BEGIN TRANSACTION READ ONLY;

\echo '== 1. Summary'
SELECT
  (SELECT COUNT(*) FROM sales)                                                    AS all_sales_rows,
  (SELECT COUNT(*) FROM attributed_sales)                                         AS attributed_rows,
  (SELECT COUNT(*) FROM sales s JOIN products p ON p.id = s.product_id
     JOIN data_uploads du ON du.id = s.upload_id
     WHERE du.uploaded_by IS DISTINCT FROM p.user_id)                             AS conflicting_rows,
  (SELECT COUNT(*) FROM sales s JOIN products p ON p.id = s.product_id
     WHERE p.user_id IS NULL)                                                     AS rows_on_ownerless_products,
  (SELECT COUNT(*) FROM sales WHERE upload_id IS NULL)                            AS rows_without_import_record;

\echo '== 2. Conflict groups (rows imported by one seller onto another owner''s / an ownerless product)'
SELECT p.id AS product_id, p.name AS product_name, p.user_id AS product_owner,
       du.uploaded_by AS importing_seller, s.upload_id,
       COUNT(*) AS rows, SUM(s.quantity) AS units, MIN(s.sale_date) AS first_date, MAX(s.sale_date) AS last_date
FROM sales s
JOIN products p      ON p.id = s.product_id
JOIN data_uploads du ON du.id = s.upload_id
WHERE du.uploaded_by IS DISTINCT FROM p.user_id
GROUP BY p.id, p.name, p.user_id, du.uploaded_by, s.upload_id
ORDER BY p.id, s.upload_id;

\echo '== 3. Dry-run mapping: proposed destination for each conflict group (sales rows move; products never transfer)'
WITH conflict AS (
  SELECT s.id AS sale_id, s.product_id, s.sale_date, s.quantity, s.revenue, s.upload_id,
         p.name, p.user_id AS owner, du.uploaded_by AS importer
  FROM sales s
  JOIN products p      ON p.id = s.product_id
  JOIN data_uploads du ON du.id = s.upload_id
  WHERE du.uploaded_by IS DISTINCT FROM p.user_id
),
grp AS (
  SELECT product_id, name, owner, importer, upload_id, COUNT(*) AS rows FROM conflict
  GROUP BY product_id, name, owner, importer, upload_id
),
product_kind AS (
  -- mixed: the product also has rows correctly attributed to its owner.
  SELECT g.product_id,
         CASE WHEN g.owner IS NULL THEN 'ownerless'
              WHEN EXISTS (SELECT 1 FROM attributed_sales a WHERE a.product_id = g.product_id) THEN 'mixed'
              ELSE 'entirely_foreign' END AS kind
  FROM (SELECT DISTINCT product_id, owner FROM grp) g
),
target AS (
  SELECT g.*, pk.kind,
         (SELECT t.id FROM products t WHERE t.user_id = g.importer AND t.name = g.name ORDER BY t.id LIMIT 1) AS existing_target
  FROM grp g JOIN product_kind pk USING (product_id)
)
SELECT product_id, name, kind, owner AS current_owner, importer AS proposed_owner, upload_id, rows,
       CASE WHEN importer IS NULL THEN 'AMBIGUOUS: import has no recorded seller'
            WHEN existing_target IS NOT NULL THEN 'move rows to importer''s existing product'
            ELSE 'create product for importer, then move rows' END AS proposed_action,
       existing_target AS target_product_id,
       -- Rows that would collide with the legacy uniqueness rule in the target product.
       (SELECT COUNT(*) FROM conflict c JOIN sales t
          ON t.product_id = target.existing_target AND t.sale_date = c.sale_date
         AND t.quantity = c.quantity AND t.revenue IS NOT DISTINCT FROM c.revenue
        WHERE c.product_id = target.product_id AND c.upload_id = target.upload_id) AS target_collisions
FROM target
ORDER BY product_id, upload_id;

\echo '== 4. Ambiguous records needing a human decision'
\echo '-- 4a. Rows with no import record on products that have conflicts (owner cannot be proven)'
SELECT s.product_id, p.name, p.user_id AS product_owner, COUNT(*) AS rows, MIN(s.sale_date), MAX(s.sale_date)
FROM sales s JOIN products p ON p.id = s.product_id
WHERE s.upload_id IS NULL
  AND s.product_id IN (SELECT s2.product_id FROM sales s2 JOIN products p2 ON p2.id = s2.product_id
                       JOIN data_uploads d2 ON d2.id = s2.upload_id WHERE d2.uploaded_by IS DISTINCT FROM p2.user_id)
GROUP BY s.product_id, p.name, p.user_id;
\echo '-- 4b. Imports with no recorded seller'
SELECT du.id AS upload_id, du.uploaded_at, du.source, COUNT(s.id) AS sales_rows
FROM data_uploads du LEFT JOIN sales s ON s.upload_id = du.id
WHERE du.uploaded_by IS NULL GROUP BY du.id ORDER BY du.id;
\echo '-- 4c. Ownerless products with sales but no import provenance'
SELECT p.id, p.name, COUNT(s.id) AS rows
FROM products p JOIN sales s ON s.product_id = p.id
WHERE p.user_id IS NULL AND s.upload_id IS NULL GROUP BY p.id, p.name;
\echo '-- 4d. Product fields that another seller''s import may have overwritten (no history is kept: price, category, stock)'
SELECT DISTINCT p.id, p.name, p.user_id AS owner, p.current_price, p.category,
       i.stock_level, i.reorder_threshold, i.updated_at AS stock_updated_at
FROM products p
JOIN sales s ON s.product_id = p.id
JOIN data_uploads du ON du.id = s.upload_id
LEFT JOIN inventory i ON i.product_id = p.id
WHERE du.uploaded_by IS DISTINCT FROM p.user_id
ORDER BY p.id;

\echo '== 5. Derived data built from affected sales'
\echo '-- 5a. Stored forecasts for affected products'
SELECT f.product_id, f.seller_id, COUNT(*) AS forecast_rows, MIN(f.created_at), MAX(f.created_at)
FROM forecasts f
WHERE f.product_id IN (SELECT s.product_id FROM sales s JOIN products p ON p.id = s.product_id
                       JOIN data_uploads du ON du.id = s.upload_id WHERE du.uploaded_by IS DISTINCT FROM p.user_id)
GROUP BY f.product_id, f.seller_id ORDER BY f.product_id;
\echo '-- 5b. Model metrics / training jobs of affected owners recorded after the first conflicting import'
WITH affected AS (
  SELECT p.user_id AS seller_id, MIN(du.uploaded_at) AS first_conflict_at
  FROM sales s JOIN products p ON p.id = s.product_id JOIN data_uploads du ON du.id = s.upload_id
  WHERE du.uploaded_by IS DISTINCT FROM p.user_id AND p.user_id IS NOT NULL
  GROUP BY p.user_id
)
SELECT 'model_metrics' AS source, m.seller_id, m.model_name AS detail, m.evaluated_at AS at
FROM model_metrics m JOIN affected a ON a.seller_id = m.seller_id WHERE m.evaluated_at >= a.first_conflict_at
UNION ALL
SELECT 'finetune_jobs', j.user_id, j.status, j.started_at
FROM finetune_jobs j JOIN affected a ON a.seller_id = j.user_id WHERE j.started_at >= a.first_conflict_at
ORDER BY 2, 4;
\echo '-- 5c. Freshness rows to recompute after any repair'
SELECT df.* FROM data_freshness df
WHERE df.seller_id IN (SELECT p.user_id FROM sales s JOIN products p ON p.id = s.product_id
                       JOIN data_uploads du ON du.id = s.upload_id
                       WHERE du.uploaded_by IS DISTINCT FROM p.user_id
                       UNION SELECT du.uploaded_by FROM sales s JOIN products p ON p.id = s.product_id
                       JOIN data_uploads du ON du.id = s.upload_id
                       WHERE du.uploaded_by IS DISTINCT FROM p.user_id);

ROLLBACK;
