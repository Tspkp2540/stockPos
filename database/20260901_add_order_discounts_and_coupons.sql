-- Run this once on an existing PostgreSQL database when migrations are managed manually.
-- The backend also applies the same non-destructive schema updates on startup.

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

-- Example coupon: 10% off, cap at 50 baht, minimum order 100 baht, usable 100 times.
-- INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit)
-- VALUES ('WELCOME10', 'PERCENT', 10, 100, 50, 100);
