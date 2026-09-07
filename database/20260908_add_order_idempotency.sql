-- Retry protection for POS order confirmation.
-- Each authenticated staff/admin request gets one client-generated request ID.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS orders_user_client_request_unique_idx
  ON orders (user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
