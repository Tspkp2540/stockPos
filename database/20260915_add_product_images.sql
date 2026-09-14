-- Store an optional CDN or public image URL for each sellable menu item.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT;
