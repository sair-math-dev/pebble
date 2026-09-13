CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS registry_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  registry_id uuid NOT NULL,
  toolchain_digest text NOT NULL,
  policy_digest text NOT NULL,
  toolchain jsonb NOT NULL,
  policy jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS principals (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS packages (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES principals(id),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS memberships (
  package_id uuid NOT NULL REFERENCES packages(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('viewer','maintainer')),
  PRIMARY KEY (package_id, principal_id)
);
CREATE TABLE IF NOT EXISTS blobs (
  digest text PRIMARY KEY,
  byte_length bigint NOT NULL CHECK (byte_length >= 0)
);
CREATE TABLE IF NOT EXISTS snapshots (
  digest text PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES packages(id),
  version text NOT NULL,
  descriptor jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS snapshot_blobs (
  snapshot_digest text NOT NULL REFERENCES snapshots(digest),
  blob_digest text NOT NULL REFERENCES blobs(digest),
  PRIMARY KEY (snapshot_digest, blob_digest)
);
CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES packages(id),
  snapshot_digest text NOT NULL REFERENCES snapshots(digest),
  creator_id uuid NOT NULL REFERENCES principals(id),
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued',
  diagnostic text,
  input_digest text NOT NULL,
  toolchain_digest text NOT NULL,
  policy_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS verification_jobs (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL UNIQUE REFERENCES candidates(id),
  requested_by uuid NOT NULL REFERENCES principals(id),
  attempt integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'queued',
  lease_token uuid,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS verification_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES verification_jobs(id),
  attempt integer NOT NULL,
  input_digest text NOT NULL,
  outcome text NOT NULL,
  report jsonb,
  report_digest text,
  diagnostic text,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, attempt)
);
CREATE TABLE IF NOT EXISTS research_reviews (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  reviewer_id uuid NOT NULL REFERENCES principals(id),
  snapshot_digest text NOT NULL REFERENCES snapshots(digest),
  approved boolean NOT NULL,
  source_classification_confirmed boolean NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES packages(id),
  version text NOT NULL,
  snapshot_digest text NOT NULL REFERENCES snapshots(digest),
  candidate_id uuid NOT NULL UNIQUE REFERENCES candidates(id),
  verification_id uuid NOT NULL REFERENCES verification_attempts(id),
  review_id uuid NOT NULL REFERENCES research_reviews(id),
  published_by uuid NOT NULL REFERENCES principals(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (package_id, version)
);
CREATE TABLE IF NOT EXISTS release_events (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES releases(id),
  kind text NOT NULL CHECK (kind IN ('withdrawal','verification_revocation')),
  actor_id uuid NOT NULL REFERENCES principals(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  resource_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  principal_id uuid NOT NULL REFERENCES principals(id),
  method text NOT NULL,
  path text NOT NULL,
  key text NOT NULL,
  request_digest text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (principal_id, method, path, key)
);
CREATE INDEX IF NOT EXISTS jobs_claim ON verification_jobs (state, available_at);
CREATE INDEX IF NOT EXISTS candidates_package ON candidates (package_id);
CREATE INDEX IF NOT EXISTS releases_page ON releases (package_id,published_at,id);
CREATE INDEX IF NOT EXISTS reviews_candidate ON research_reviews (candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_release ON release_events (release_id);

CREATE OR REPLACE FUNCTION pebble_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable registry record' USING ERRCODE = '23000'; END;
$$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['snapshots','snapshot_blobs','blobs','releases','release_events','verification_attempts','research_reviews','outbox_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable' AND tgrelid = format('%I',name)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pebble_immutable()', name || '_immutable', name);
    END IF;
  END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
