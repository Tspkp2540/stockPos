-- Run this once on an existing PostgreSQL database when migrations are managed manually.
-- The backend also applies the same non-destructive schema updates on startup.

-- Manual temporary sold-out state. Automatic availability is calculated from unexpired lots.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sold_out BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  discount_type VARCHAR(12) NOT NULL CHECK (discount_type IN ('AMOUNT', 'PERCENT')),
  discount_value NUMERIC(12, 2) NOT NULL CHECK (discount_value > 0),
  min_order_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  max_discount_amount NUMERIC(12, 2),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manual_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id BIGINT REFERENCES coupons(id);

CREATE INDEX IF NOT EXISTS coupons_active_code_idx ON coupons(UPPER(code)) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  min_selection INTEGER NOT NULL DEFAULT 0 CHECK (min_selection >= 0),
  max_selection INTEGER NOT NULL DEFAULT 1 CHECK (max_selection > 0),
  display_order INTEGER NOT NULL DEFAULT 0,
  CHECK (min_selection <= max_selection)
);

CREATE TABLE IF NOT EXISTS product_modifier_options (
  id BIGSERIAL PRIMARY KEY,
  modifier_group_id BIGINT NOT NULL REFERENCES product_modifier_groups(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  price_adjustment NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id BIGSERIAL PRIMARY KEY,
  order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_option_id BIGINT REFERENCES product_modifier_options(id) ON DELETE SET NULL,
  group_name VARCHAR(100) NOT NULL,
  option_name VARCHAR(100) NOT NULL,
  price_adjustment NUMERIC(12, 2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS product_modifier_groups_product_idx
  ON product_modifier_groups(product_id, display_order);

CREATE INDEX IF NOT EXISTS order_item_modifiers_item_idx
  ON order_item_modifiers(order_item_id);

CREATE TABLE IF NOT EXISTS cash_shifts (
  id BIGSERIAL PRIMARY KEY,
  opened_by BIGINT NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opening_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  opening_note TEXT NOT NULL DEFAULT '',
  status VARCHAR(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closing_cash NUMERIC(12, 2),
  expected_cash NUMERIC(12, 2),
  difference_amount NUMERIC(12, 2),
  closing_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS order_payments (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  cash_shift_id BIGINT REFERENCES cash_shifts(id) ON DELETE SET NULL,
  paid_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  payment_method VARCHAR(16) NOT NULL
    CHECK (payment_method IN ('CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER')),
  paid_amount NUMERIC(12, 2) NOT NULL CHECK (paid_amount >= 0),
  amount_received NUMERIC(12, 2) NOT NULL CHECK (amount_received >= 0),
  change_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  status VARCHAR(12) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'VOIDED')),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_shifts_one_open_per_user_idx
  ON cash_shifts(opened_by) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS order_payments_cash_shift_idx
  ON order_payments(cash_shift_id, status);

-- Supplier and stock receiving: keeps the source, actual purchase cost, and receipt history of inventory.
CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL UNIQUE,
  contact_name VARCHAR(120) NOT NULL DEFAULT '',
  phone VARCHAR(30) NOT NULL DEFAULT '',
  email VARCHAR(160) NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_receipts (
  id BIGSERIAL PRIMARY KEY,
  receipt_no VARCHAR(64) NOT NULL UNIQUE,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT NOT NULL DEFAULT '',
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_receipt_items (
  id BIGSERIAL PRIMARY KEY,
  receipt_id BIGINT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGSERIAL PRIMARY KEY,
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  movement_type VARCHAR(24) NOT NULL
    CHECK (movement_type IN ('INITIAL', 'PURCHASE', 'MANUAL_RESTOCK', 'ADJUSTMENT')),
  quantity_change NUMERIC(12, 3) NOT NULL,
  unit_cost NUMERIC(12, 2),
  reference_type VARCHAR(32) NOT NULL DEFAULT '',
  reference_id BIGINT,
  note TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS stock_receipts_received_at_idx
  ON stock_receipts(received_at DESC);
CREATE INDEX IF NOT EXISTS stock_receipt_items_receipt_idx
  ON stock_receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS inventory_movements_ingredient_idx
  ON inventory_movements(ingredient_id, created_at DESC);

-- Inventory lots: every receiving line creates one lot. Orders allocate stock by FEFO.
CREATE TABLE IF NOT EXISTS inventory_lots (
  id BIGSERIAL PRIMARY KEY,
  ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
  stock_receipt_item_id BIGINT REFERENCES stock_receipt_items(id) ON DELETE SET NULL,
  lot_no VARCHAR(100) NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expiry_date DATE,
  initial_quantity NUMERIC(12, 3) NOT NULL CHECK (initial_quantity > 0),
  remaining_quantity NUMERIC(12, 3) NOT NULL CHECK (remaining_quantity >= 0),
  unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_item_lot_allocations (
  id BIGSERIAL PRIMARY KEY,
  order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  inventory_lot_id BIGINT NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(12, 4) NOT NULL CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_receipt_item_unique_idx
  ON inventory_lots(stock_receipt_item_id)
  WHERE stock_receipt_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_lots_fefo_idx
  ON inventory_lots(ingredient_id, expiry_date, received_at)
  WHERE remaining_quantity > 0;
CREATE INDEX IF NOT EXISTS order_item_lot_allocations_order_item_idx
  ON order_item_lot_allocations(order_item_id);

-- Open one starting lot for existing inventory that predates lot tracking.
INSERT INTO inventory_lots
  (ingredient_id, lot_no, received_at, expiry_date, initial_quantity, remaining_quantity, unit_cost)
SELECT i.id, 'OPENING-' || i.id, CURRENT_TIMESTAMP, i.expiry_date,
       i.stock_qty, i.stock_qty, i.cost_per_unit
FROM ingredients i
WHERE i.stock_qty > 0
  AND NOT EXISTS (
    SELECT 1 FROM inventory_lots il WHERE il.ingredient_id = i.id
  );

-- Example coupon: 10% off, cap at 50 baht, minimum order 100 baht, usable 100 times.
-- INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit)
-- VALUES ('WELCOME10', 'PERCENT', 10, 100, 50, 100);
