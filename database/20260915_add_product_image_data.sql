-- Menu images. `image_url` supports legacy external images, while `image_data`
-- stores small browser-compressed WebP images uploaded by the shop owner.
-- The application caps each uploaded image at 120 KB before it is stored here.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_data TEXT;
