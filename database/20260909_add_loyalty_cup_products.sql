-- Only products explicitly marked as a drink count toward CUP loyalty rewards.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS counts_as_loyalty_cup BOOLEAN NOT NULL DEFAULT FALSE;
