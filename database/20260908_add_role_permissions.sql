CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(32) PRIMARY KEY,
  base_role VARCHAR(16) NOT NULL DEFAULT 'USER' CHECK (base_role IN ('ADMIN', 'STAFF', 'USER')),
  display_name VARCHAR(80) NOT NULL DEFAULT '',
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role_key VARCHAR(32);
UPDATE users SET role_key = role WHERE role_key IS NULL OR role_key = '';
ALTER TABLE users ALTER COLUMN role_key SET DEFAULT 'USER';
ALTER TABLE users ALTER COLUMN role_key SET NOT NULL;
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE role_permissions ALTER COLUMN role TYPE VARCHAR(32);
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS base_role VARCHAR(16) NOT NULL DEFAULT 'USER';
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS display_name VARCHAR(80) NOT NULL DEFAULT '';
UPDATE role_permissions SET base_role = role WHERE role IN ('ADMIN', 'STAFF', 'USER') AND base_role = 'USER';
UPDATE role_permissions SET display_name = role WHERE display_name = '';

INSERT INTO role_permissions (role, base_role, display_name, permissions) VALUES
  ('ADMIN', 'ADMIN', 'ADMIN', '{"operations":{"view":true,"create":true,"update":true,"delete":true},"pos":{"view":true,"create":true,"update":true,"delete":true},"orders":{"view":true,"create":true,"update":true,"delete":true}}'::jsonb),
  ('STAFF', 'STAFF', 'STAFF', '{"pos":{"view":true,"create":true,"update":true,"delete":false},"orders":{"view":true,"create":false,"update":true,"delete":false},"kitchen":{"view":true,"create":false,"update":true,"delete":false}}'::jsonb),
  ('USER', 'USER', 'USER', '{"orders":{"view":true,"create":false,"update":false,"delete":false}}'::jsonb)
ON CONFLICT (role) DO NOTHING;
