-- Packages are keyed by name; versions are published as archives in a sparse
-- index; namespace prefixes have owners. The snapshot/blob protocol and its
-- tables are removed: nothing published under it exists outside local runs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 3) THEN
    DROP TABLE IF EXISTS release_events, releases, research_reviews, verification_attempts,
      verification_jobs, candidates, snapshot_blobs, snapshots, blobs CASCADE;
    DELETE FROM idempotency_keys;
    DELETE FROM packages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packages_name_shape') THEN
    ALTER TABLE packages ADD CONSTRAINT packages_name_shape CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$');
  END IF;
END $$;

ALTER TABLE principals ADD COLUMN IF NOT EXISTS maintainer boolean NOT NULL DEFAULT false;
ALTER TABLE packages ALTER COLUMN visibility SET DEFAULT 'public';

CREATE TABLE IF NOT EXISTS namespace_prefixes (
  prefix text PRIMARY KEY CHECK (prefix ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$'),
  package_id uuid NOT NULL REFERENCES packages(id),
  granted_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS prefixes_package ON namespace_prefixes (package_id);

CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES packages(id),
  version text NOT NULL,
  level text NOT NULL CHECK (level IN ('patch','minor','major')),
  manifest text NOT NULL,
  deps jsonb NOT NULL,
  prefixes jsonb NOT NULL,
  toolchain text NOT NULL,
  cksum text NOT NULL CHECK (cksum ~ '^[a-f0-9]{64}$'),
  iface_cksum text NOT NULL CHECK (iface_cksum ~ '^[a-f0-9]{64}$'),
  creator_id uuid NOT NULL REFERENCES principals(id),
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','incomplete','timeout','error','rejected','pending_review','published')),
  diagnostic text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS candidates_package ON candidates (package_id, version);

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
CREATE INDEX IF NOT EXISTS jobs_claim ON verification_jobs (state, available_at);

CREATE TABLE IF NOT EXISTS verification_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES verification_jobs(id),
  attempt integer NOT NULL,
  outcome text NOT NULL,
  report jsonb,
  report_digest text,
  computed_level text CHECK (computed_level IN ('patch','minor','major')),
  interface_text text,
  diagnostic text,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS research_reviews (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  reviewer_id uuid NOT NULL REFERENCES principals(id),
  revision integer NOT NULL,
  approved boolean NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS reviews_candidate ON research_reviews (candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS package_versions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES packages(id),
  version text NOT NULL,
  candidate_id uuid NOT NULL UNIQUE REFERENCES candidates(id),
  verification_id uuid NOT NULL REFERENCES verification_attempts(id),
  review_id uuid REFERENCES research_reviews(id),
  published_by uuid NOT NULL REFERENCES principals(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cksum text NOT NULL,
  iface_cksum text NOT NULL,
  deps jsonb NOT NULL,
  prefixes jsonb NOT NULL,
  toolchain text NOT NULL,
  interface_text text NOT NULL,
  yanked boolean NOT NULL DEFAULT false,
  yanked_at timestamptz,
  yanked_by uuid REFERENCES principals(id),
  UNIQUE (package_id, version)
);

-- Published version rows change only their yank state.
CREATE OR REPLACE FUNCTION pebble_version_yank_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable registry record' USING ERRCODE = '23000'; END IF;
  IF NEW.id <> OLD.id OR NEW.package_id <> OLD.package_id OR NEW.version <> OLD.version OR NEW.candidate_id <> OLD.candidate_id
     OR NEW.cksum <> OLD.cksum OR NEW.iface_cksum <> OLD.iface_cksum OR NEW.interface_text <> OLD.interface_text
     OR NEW.published_by <> OLD.published_by OR NEW.published_at <> OLD.published_at THEN
    RAISE EXCEPTION 'immutable registry record' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['verification_attempts','research_reviews','outbox_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = name || '_immutable' AND tgrelid = format('%I',name)::regclass) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pebble_immutable()', name || '_immutable', name);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'package_versions_yank_only' AND tgrelid = 'package_versions'::regclass) THEN
    CREATE TRIGGER package_versions_yank_only BEFORE UPDATE OR DELETE ON package_versions FOR EACH ROW EXECUTE FUNCTION pebble_version_yank_only();
  END IF;
END $$;
INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT DO NOTHING;
