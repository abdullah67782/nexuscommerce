-- 005: suppliers and purchasing — Stage 1b of Inventory AI
-- (docs/inventory-stage1-plan.md §3.2 and §10).
--
-- Rules carried by the schema:
--   * Approving or ordering never changes stock. Only a RECEIPT writes a stock
--     movement ('receipt', +qty, effective at received_at), one per receipt line.
--   * Receipts are never edited or deleted (append-only triggers below).
--   * Two different ways to undo a receipt (§10):
--       correction       the receipt was recorded wrongly. A 'receipt_correction'
--                        movement (−qty) effective at the receipt's own instant, so
--                        a later physical count stays authoritative. It reduces the
--                        quantity received on the order line.
--       supplier_return  goods physically go back now. A 'supplier_return' movement
--                        (−qty) at the return time. The received quantity is unchanged.
--     Corrections + returns of a receipt line never exceed that line's quantity.
--   * Order-state transitions and promised-arrival revisions are kept as durable,
--     append-only history (purchase_order_events).

-- ── Suppliers ───────────────────────────────────────────────────────────────
CREATE TABLE suppliers (
  id                SERIAL PRIMARY KEY,
  seller_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              VARCHAR(160) NOT NULL CHECK (btrim(name) <> ''),
  email             VARCHAR(255),
  phone             VARCHAR(60),
  default_currency  CHAR(3) NOT NULL DEFAULT 'PKR' CHECK (default_currency ~ '^[A-Z]{3}$'),
  notes             TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, seller_id)
);
CREATE UNIQUE INDEX suppliers_name_uq ON suppliers (seller_id, lower(btrim(name)));

-- Seller-entered terms for buying one product from one supplier.
CREATE TABLE product_suppliers (
  id              SERIAL PRIMARY KEY,
  seller_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id      INT NOT NULL,
  supplier_id     INT NOT NULL,
  supplier_sku    VARCHAR(120),
  unit_cost       NUMERIC(12,2) CHECK (unit_cost >= 0),
  currency        CHAR(3) CHECK (currency ~ '^[A-Z]{3}$'),
  lead_time_days  INT CHECK (lead_time_days BETWEEN 0 AND 365),
  min_order_qty   INT NOT NULL DEFAULT 1 CHECK (min_order_qty >= 1),
  pack_size       INT NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  is_preferred    BOOLEAN NOT NULL DEFAULT FALSE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (unit_cost IS NULL OR currency IS NOT NULL),          -- a cost always names its currency (D9)
  UNIQUE (seller_id, product_id, supplier_id),
  UNIQUE (id, seller_id),
  CONSTRAINT product_suppliers_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id),
  CONSTRAINT product_suppliers_supplier_fk FOREIGN KEY (supplier_id, seller_id) REFERENCES suppliers (id, seller_id)
);
CREATE UNIQUE INDEX product_suppliers_one_preferred ON product_suppliers (seller_id, product_id) WHERE is_preferred AND active;

-- ── Purchase orders ─────────────────────────────────────────────────────────
CREATE TABLE purchase_orders (
  id                SERIAL PRIMARY KEY,
  seller_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supplier_id       INT NOT NULL,
  location_id       INT NOT NULL,
  currency          CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),   -- one currency per order
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'approved', 'ordered', 'partially_received', 'received', 'cancelled')),
  idempotency_key   VARCHAR(220) NOT NULL,
  content_sha256    CHAR(64) NOT NULL,
  version           INT NOT NULL DEFAULT 1 CHECK (version >= 1),         -- optimistic concurrency
  expected_arrival  DATE,                                                -- supplier promise (business date)
  notes             TEXT,
  unknown_costs_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by       INT REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  ordered_at        TIMESTAMPTZ,
  first_receipt_at  TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  cancelled_by      INT REFERENCES users(id),
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT,
  UNIQUE (seller_id, idempotency_key),
  UNIQUE (id, seller_id),
  CONSTRAINT purchase_orders_supplier_fk FOREIGN KEY (supplier_id, seller_id) REFERENCES suppliers (id, seller_id),
  CONSTRAINT purchase_orders_location_fk FOREIGN KEY (location_id, seller_id) REFERENCES inventory_locations (id, seller_id),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR btrim(coalesce(cancel_reason, '')) <> ''),
  CHECK (status NOT IN ('approved', 'ordered', 'partially_received', 'received') OR approved_at IS NOT NULL),
  CHECK (status NOT IN ('ordered', 'partially_received', 'received') OR ordered_at IS NOT NULL),
  CHECK ((status = 'received') = (completed_at IS NOT NULL))
);

CREATE TABLE purchase_order_lines (
  id                  SERIAL PRIMARY KEY,
  seller_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  po_id               INT NOT NULL,
  product_id          INT NOT NULL,
  quantity_ordered    INT NOT NULL CHECK (quantity_ordered > 0),
  quantity_cancelled  INT NOT NULL DEFAULT 0 CHECK (quantity_cancelled >= 0),
  -- terms copied from the product–supplier link when drafted (snapshots)
  unit_cost           NUMERIC(12,2) CHECK (unit_cost >= 0),
  cost_currency       CHAR(3) CHECK (cost_currency ~ '^[A-Z]{3}$'),
  pack_size           INT NOT NULL CHECK (pack_size >= 1),
  min_order_qty       INT NOT NULL CHECK (min_order_qty >= 1),
  CHECK (quantity_cancelled <= quantity_ordered),
  CHECK (unit_cost IS NULL OR cost_currency IS NOT NULL),
  UNIQUE (po_id, product_id),
  UNIQUE (id, seller_id),
  CONSTRAINT purchase_order_lines_po_fk FOREIGN KEY (po_id, seller_id) REFERENCES purchase_orders (id, seller_id),
  CONSTRAINT purchase_order_lines_product_fk FOREIGN KEY (product_id, seller_id) REFERENCES products (id, user_id)
);

-- ── Receipts (append-only) ─────────────────────────────────────────────────
CREATE TABLE purchase_receipts (
  id               SERIAL PRIMARY KEY,
  seller_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  po_id            INT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by      INT REFERENCES users(id),
  idempotency_key  VARCHAR(220) NOT NULL,
  content_sha256   CHAR(64) NOT NULL,
  note             TEXT,
  UNIQUE (seller_id, idempotency_key),
  UNIQUE (id, seller_id),
  CONSTRAINT purchase_receipts_po_fk FOREIGN KEY (po_id, seller_id) REFERENCES purchase_orders (id, seller_id)
);

CREATE TABLE purchase_receipt_lines (
  id          SERIAL PRIMARY KEY,
  seller_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_id  INT NOT NULL,
  po_line_id  INT NOT NULL,
  quantity    INT NOT NULL CHECK (quantity > 0),
  UNIQUE (receipt_id, po_line_id),
  UNIQUE (id, seller_id),
  CONSTRAINT purchase_receipt_lines_receipt_fk FOREIGN KEY (receipt_id, seller_id) REFERENCES purchase_receipts (id, seller_id),
  CONSTRAINT purchase_receipt_lines_po_line_fk FOREIGN KEY (po_line_id, seller_id) REFERENCES purchase_order_lines (id, seller_id)
);

-- Corrections (recorded wrongly) and supplier returns (goods sent back), per receipt line.
CREATE TABLE purchase_receipt_adjustments (
  id               SERIAL PRIMARY KEY,
  seller_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receipt_line_id  INT NOT NULL,
  kind             VARCHAR(20) NOT NULL CHECK (kind IN ('correction', 'supplier_return')),
  quantity         INT NOT NULL CHECK (quantity > 0),
  effective_at     TIMESTAMPTZ NOT NULL,
  reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
  request_key      VARCHAR(220) NOT NULL,
  request_sha256   CHAR(64) NOT NULL,
  recorded_by      INT REFERENCES users(id),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, request_key, receipt_line_id),
  UNIQUE (id, seller_id),
  CONSTRAINT purchase_receipt_adjustments_line_fk FOREIGN KEY (receipt_line_id, seller_id) REFERENCES purchase_receipt_lines (id, seller_id)
);

-- ── Durable order history (append-only) ────────────────────────────────────
CREATE TABLE purchase_order_events (
  id           SERIAL PRIMARY KEY,
  seller_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  po_id        INT NOT NULL,
  event        VARCHAR(30) NOT NULL CHECK (event IN ('created', 'edited', 'approved', 'ordered', 'received_goods',
                 'receipt_corrected', 'goods_returned', 'status_changed', 'expected_arrival_changed', 'cancelled')),
  from_status  VARCHAR(20),
  to_status    VARCHAR(20),
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor        INT REFERENCES users(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT purchase_order_events_po_fk FOREIGN KEY (po_id, seller_id) REFERENCES purchase_orders (id, seller_id)
);
CREATE INDEX purchase_order_events_po ON purchase_order_events (po_id, id);

CREATE FUNCTION purchasing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows are never changed or deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER purchase_receipts_append_only BEFORE UPDATE OR DELETE ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();
CREATE TRIGGER purchase_receipt_lines_append_only BEFORE UPDATE OR DELETE ON purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();
CREATE TRIGGER purchase_receipt_adjustments_append_only BEFORE UPDATE OR DELETE ON purchase_receipt_adjustments
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();
CREATE TRIGGER purchase_order_events_append_only BEFORE UPDATE OR DELETE ON purchase_order_events
  FOR EACH ROW EXECUTE FUNCTION purchasing_append_only();

-- ── Stock movements written by purchasing ──────────────────────────────────
ALTER TABLE stock_movements ADD COLUMN receipt_line_id INT;
ALTER TABLE stock_movements ADD COLUMN receipt_adjustment_id INT;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_receipt_line_fk
  FOREIGN KEY (receipt_line_id, seller_id) REFERENCES purchase_receipt_lines (id, seller_id);
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_receipt_adjustment_fk
  FOREIGN KEY (receipt_adjustment_id, seller_id) REFERENCES purchase_receipt_adjustments (id, seller_id);

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN
  ('shipment', 'customer_return', 'damage', 'found', 'correction', 'receipt', 'receipt_correction', 'supplier_return'));
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign_check CHECK (CASE kind
  WHEN 'shipment' THEN quantity < 0 WHEN 'damage' THEN quantity < 0
  WHEN 'customer_return' THEN quantity > 0 WHEN 'found' THEN quantity > 0
  WHEN 'receipt' THEN quantity > 0
  WHEN 'receipt_correction' THEN quantity < 0 WHEN 'supplier_return' THEN quantity < 0
  ELSE TRUE END);
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_check3;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_reason_check
  CHECK (kind IN ('shipment', 'customer_return', 'receipt') OR reason IS NOT NULL);
-- Purchasing movements always point at what wrote them, and nothing else does.
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_receipt_link_check
  CHECK ((kind = 'receipt') = (receipt_line_id IS NOT NULL));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_adjustment_link_check
  CHECK ((kind IN ('receipt_correction', 'supplier_return')) = (receipt_adjustment_id IS NOT NULL));
-- Exactly one stock movement per receipt line and per adjustment: a replay can never add stock twice.
CREATE UNIQUE INDEX stock_movements_one_per_receipt_line ON stock_movements (receipt_line_id) WHERE receipt_line_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_one_per_adjustment ON stock_movements (receipt_adjustment_id) WHERE receipt_adjustment_id IS NOT NULL;

-- ── Line quantities (received is net of corrections; returns are separate) ──
CREATE VIEW purchase_order_line_quantities AS
SELECT l.id AS line_id, l.seller_id, l.po_id, l.product_id, po.status,
       l.quantity_ordered, l.quantity_cancelled,
       COALESCE(r.gross, 0)::int AS quantity_received_gross,
       COALESCE(a.corrected, 0)::int AS quantity_corrected,
       (COALESCE(r.gross, 0) - COALESCE(a.corrected, 0))::int AS quantity_received,
       COALESCE(a.returned, 0)::int AS quantity_returned,
       CASE WHEN po.status = 'cancelled' THEN 0
            ELSE GREATEST(l.quantity_ordered - l.quantity_cancelled - (COALESCE(r.gross, 0) - COALESCE(a.corrected, 0)), 0)
       END::int AS quantity_remaining
FROM purchase_order_lines l
JOIN purchase_orders po ON po.id = l.po_id
LEFT JOIN (SELECT po_line_id, SUM(quantity) AS gross FROM purchase_receipt_lines GROUP BY po_line_id) r ON r.po_line_id = l.id
LEFT JOIN (SELECT rl.po_line_id,
                  SUM(ad.quantity) FILTER (WHERE ad.kind = 'correction') AS corrected,
                  SUM(ad.quantity) FILTER (WHERE ad.kind = 'supplier_return') AS returned
           FROM purchase_receipt_adjustments ad JOIN purchase_receipt_lines rl ON rl.id = ad.receipt_line_id
           GROUP BY rl.po_line_id) a ON a.po_line_id = l.id;
