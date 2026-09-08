CREATE TABLE IF NOT EXISTS role_permissions (
  role VARCHAR(16) PRIMARY KEY CHECK (role IN ('ADMIN', 'STAFF', 'USER')),
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO role_permissions (role, permissions) VALUES
  ('ADMIN', '{"operations":{"view":true,"create":true,"update":true,"delete":true},"pos":{"view":true,"create":true,"update":true,"delete":true},"orders":{"view":true,"create":true,"update":true,"delete":true}}'::jsonb),
  ('STAFF', '{"pos":{"view":true,"create":true,"update":true,"delete":false},"orders":{"view":true,"create":false,"update":true,"delete":false},"kitchen":{"view":true,"create":false,"update":true,"delete":false}}'::jsonb),
  ('USER', '{"orders":{"view":true,"create":false,"update":false,"delete":false}}'::jsonb)
ON CONFLICT (role) DO NOTHING;
