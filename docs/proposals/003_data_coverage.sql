-- ════════════════════════════════════════════════════════════════════════════
-- PROPOSAL 003 — data coverage. DESIGN DRAFT, NOT A MIGRATION.
-- Lives in docs/ so the migration runner never sees it. Requires 002.
-- Design notes: docs/import-identity-and-coverage.md, section E.
-- ════════════════════════════════════════════════════════════════════════════

-- Targets for composite ownership keys.
ALTER TABLE data_uploads ADD CONSTRAINT data_uploads_id_seller_uq UNIQUE (id, uploaded_by);
ALTER TABLE products     ADD CONSTRAINT products_id_owner_uq     UNIQUE (id, user_id);

CREATE TABLE data_coverage (
  id              SERIAL PRIMARY KEY,
  seller_id       INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id       INT  NOT NULL,                       -- coverage is per source, never global
  upload_id       INT,                                 -- the import that carried the declaration
  scope           VARCHAR(16) NOT NULL CHECK (scope IN ('all_products', 'listed_products')),
  observed_start  DATE,                                -- informational only
  observed_end    DATE,
  declared_start  DATE,                                -- inclusive business-local days
  declared_end    DATE,                                --   in data_sources.timezone
  status          VARCHAR(12) NOT NULL DEFAULT 'unconfirmed'
                  CHECK (status IN ('unconfirmed', 'confirmed', 'revoked')),
  evidence        VARCHAR(30) CHECK (evidence IN ('seller_declaration', 'connector_full_export')),
  evidence_note   TEXT,
  declared_by     INT REFERENCES users(id),
  declared_at     TIMESTAMP,
  revoked_by      INT REFERENCES users(id),
  revoked_at      TIMESTAMP,
  revoke_reason   VARCHAR(20) CHECK (revoke_reason IN ('rollback', 'seller_revoked')),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_id),
  -- one seller across coverage, source and import
  FOREIGN KEY (source_id, seller_id) REFERENCES data_sources (id, seller_id),
  FOREIGN KEY (upload_id, seller_id) REFERENCES data_uploads (id, uploaded_by),
  CHECK (status <> 'confirmed' OR (declared_start IS NOT NULL AND declared_end IS NOT NULL
         AND declared_start <= declared_end AND evidence IS NOT NULL
         AND declared_by = seller_id AND declared_at IS NOT NULL)),
  CHECK (status <> 'revoked' OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX data_coverage_lookup ON data_coverage (seller_id, source_id, status);

CREATE TABLE data_coverage_products (               -- only for scope = 'listed_products'
  coverage_id INT NOT NULL,
  product_id  INT NOT NULL,
  seller_id   INT NOT NULL,
  PRIMARY KEY (coverage_id, product_id),
  FOREIGN KEY (coverage_id, seller_id) REFERENCES data_coverage (id, seller_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, seller_id)  REFERENCES products (id, user_id) ON DELETE CASCADE
);

-- Application rules (not expressible as constraints):
--  * declared_end <= today in the source timezone (checked on write).
--  * A confirmed declaration may come with ZERO rows: the import record then has
--    total_records = 0 and establishes zero sales for the covered days.
--  * Rollback of an import revokes its coverage in the same transaction.
--  * Union of confirmed intervals only within (source, product scope).
--  * A day is "known" for a product only if every source that sells it covers
--    that day; otherwise it is unknown, never zero.
-- Backfill: every existing import gets an 'unconfirmed' row with observed dates.
