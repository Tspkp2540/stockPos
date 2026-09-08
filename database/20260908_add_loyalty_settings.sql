-- Configurable loyalty rules. The application also creates this table on startup.
CREATE TABLE IF NOT EXISTS loyalty_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  earn_mode VARCHAR(12) NOT NULL DEFAULT 'SPEND' CHECK (earn_mode IN ('SPEND', 'CUP')),
  spend_per_point NUMERIC(12, 2) NOT NULL DEFAULT 25 CHECK (spend_per_point > 0),
  cups_per_point NUMERIC(12, 2) NOT NULL DEFAULT 1 CHECK (cups_per_point > 0),
  baht_per_point NUMERIC(12, 2) NOT NULL DEFAULT 0.10 CHECK (baht_per_point > 0),
  max_redeem_percent NUMERIC(5, 2) NOT NULL DEFAULT 50 CHECK (max_redeem_percent >= 0 AND max_redeem_percent <= 100),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO loyalty_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Required only when loyalty_settings was created by an earlier release.
ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS earn_mode VARCHAR(12) NOT NULL DEFAULT 'SPEND';
ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS cups_per_point NUMERIC(12, 2) NOT NULL DEFAULT 1;
