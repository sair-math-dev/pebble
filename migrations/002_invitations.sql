CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_principal_id uuid UNIQUE REFERENCES principals(id),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_principal_id IS NULL)),
  CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
