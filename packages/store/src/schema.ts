/**
 * Postgres schema. Applied idempotently on connect — additive-only for now;
 * a real migration tool comes when the schema starts evolving.
 *
 * Screenshots never enter the database: the filesystem (traces) holds the
 * bulk; rows hold structure and pointers.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id          UUID PRIMARY KEY,
  task        TEXT NOT NULL,
  profile     TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  steps_taken INT,
  result      TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  run_id     UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INT NOT NULL,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS skills (
  id            UUID PRIMARY KEY,
  domain        TEXT NOT NULL,
  title         TEXT NOT NULL,
  url_pattern   TEXT NOT NULL,
  preconditions JSONB NOT NULL DEFAULT '[]',
  steps         JSONB NOT NULL,
  score         INT NOT NULL DEFAULT 0,
  uses          INT NOT NULL DEFAULT 0,
  retired       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills (domain) WHERE NOT retired;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS memory_runs (
  id        BIGSERIAL PRIMARY KEY,
  task      TEXT NOT NULL,
  domain    TEXT NOT NULL,
  success   BOOLEAN NOT NULL,
  steps     INT NOT NULL,
  result    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  trace_dir TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_runs_domain ON memory_runs (domain);

-- additive migration for databases created before multi-user auth
ALTER TABLE runs ADD COLUMN IF NOT EXISTS user_id UUID;
`;
