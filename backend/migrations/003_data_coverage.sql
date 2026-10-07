-- 003: confirmed data coverage (docs/import-identity-and-coverage.md, section E).
--
-- A seller (or a connector) can confirm that an import contains ALL sales of one
-- source for an inclusive range of business-local days, for all products or for
-- the products listed in the import. Inside confirmed coverage a day without
-- rows is a genuine zero; outside it, a day without rows stays unknown.
-- A rollback revokes the import's coverage in the same transaction.

-- Targets for the composite ownership keys below.
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_id_seller_uq UNIQUE (id, uploaded_by);
ALTER TABLE products     ADD CONSTRAINT products_id_owner_uq     UNIQUE (id, user_id);

CREATE TABLE data_coverage (
  id              SERIAL PRIMARY KEY,
  seller_id       INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id       INT  NOT NULL,
  upload_id       INT  NOT NULL,
  scope           VARCHAR(16) NOT NULL CHECK (scope IN ('all_products', 'listed_products')),
  declared_start  DATE NOT NULL,
  declared_end    DATE NOT NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'revoked')),
  evidence        VARCHAR(30) NOT NULL CHECK (evidence IN ('seller_declaration', 'connector_full_export')),
  declared_by     INT NOT NULL REFERENCES users(id),
  declared_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  revoked_by      INT REFERENCES users(id),
  revoked_at      TIMESTAMP,
  revoke_reason   VARCHAR(20) CHECK (revoke_reason IN ('rollback', 'seller_revoked')),
  UNIQUE (id, seller_id),
  UNIQUE (upload_id),                                   -- one declaration per import
  -- coverage, its source and its import all belong to one seller
  CONSTRAINT data_coverage_source_owner_fk FOREIGN KEY (source_id, seller_id) REFERENCES data_sources (id, seller_id),
  CONSTRAINT data_coverage_upload_owner_fk FOREIGN KEY (upload_id, seller_id) REFERENCES data_uploads (id, uploaded_by),
  CHECK (declared_start <= declared_end),
  CHECK (declared_by = seller_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX data_coverage_lookup ON data_coverage (seller_id, source_id, status);

CREATE TABLE data_coverage_products (                 -- only for scope = 'listed_products'
  coverage_id INT NOT NULL,
  product_id  INT NOT NULL,
  seller_id   INT NOT NULL,
  PRIMARY KEY (coverage_id, product_id),
  CONSTRAINT data_coverage_products_coverage_fk FOREIGN KEY (coverage_id, seller_id) REFERENCES data_coverage (id, seller_id) ON DELETE CASCADE,
  CONSTRAINT data_coverage_products_product_fk  FOREIGN KEY (product_id, seller_id)  REFERENCES products (id, user_id) ON DELETE CASCADE
);

-- Coverage resolution needs each sale's source. Same rows as before; one column added at the end.
CREATE OR REPLACE VIEW attributed_sales AS
SELECT s.id, s.product_id, s.quantity, s.sale_date, s.revenue, s.upload_id, s.created_at,
       p.user_id AS seller_id, s.source_id
FROM sales s
JOIN products p ON p.id = s.product_id
LEFT JOIN data_uploads du ON du.id = s.upload_id
WHERE p.user_id IS NOT NULL
  AND (s.upload_id IS NULL OR du.uploaded_by = p.user_id);
