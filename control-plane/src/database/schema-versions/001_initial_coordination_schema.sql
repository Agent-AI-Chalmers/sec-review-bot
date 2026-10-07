CREATE TABLE review_runs (
  run_id text PRIMARY KEY,
  connector_id text NOT NULL,
  workflow text NOT NULL,
  publish_context jsonb NOT NULL,
  runner_input jsonb,
  runner_status text NOT NULL CHECK (runner_status IN ('preparing', 'recovering', 'queued', 'running', 'succeeded', 'failed')),
  runner_failure_code text,
  runner_failure_message text,
  artifact_publication jsonb,
  workflow_result jsonb,
  preparation_claim_token uuid,
  preparation_claimed_at timestamptz,
  recovery_claim_token uuid,
  ingress_kind text,
  ingress_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, ingress_kind, ingress_key)
);

CREATE INDEX review_runs_runner_status_idx
  ON review_runs (runner_status, updated_at);

CREATE TABLE publications (
  run_id text PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'not_required')),
  claim_token uuid,
  claimed_at timestamptz,
  failure_code text,
  failure_message text,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, run_id)
);

CREATE INDEX publications_status_idx
  ON publications (status, updated_at);

CREATE TABLE publication_steps (
  connector_id text NOT NULL,
  run_id text NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
  step_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'terminal_failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  remote_object_id text,
  remote_object_url text,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connector_id, run_id, step_key)
);
