-- One row represents the complete Control Plane lifecycle of a review request,
-- from durable admission and input preparation through the terminal Runner result.
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

COMMENT ON TABLE review_runs IS
  'Durable review identity and Runner-side lifecycle. Publication has a separate state machine in publications.';
COMMENT ON COLUMN review_runs.run_id IS
  'Stable review execution identity assigned before input preparation begins and shared with the Runner.';
COMMENT ON COLUMN review_runs.connector_id IS
  'Coordination namespace that owns the run, such as one configured GitHub App connector.';
COMMENT ON COLUMN review_runs.workflow IS
  'Workflow contract used to validate, submit, observe, and publish this review.';
COMMENT ON COLUMN review_runs.publish_context IS
  'Connector-owned data needed to publish the result, such as repository and pull request identity; it is not sent to the Runner.';
COMMENT ON COLUMN review_runs.runner_input IS
  'Prepared Runner request, including artifact references. It is retained so an uncertain submission can be replayed safely.';
COMMENT ON COLUMN review_runs.runner_status IS
  'Control Plane view of preparation, submission recovery, and Runner execution; publication progress is stored separately.';
COMMENT ON COLUMN review_runs.runner_failure_code IS
  'Machine-readable reason for a preparation, submission, polling, or Runner execution failure.';
COMMENT ON COLUMN review_runs.runner_failure_message IS
  'Operator-readable detail associated with runner_failure_code.';
COMMENT ON COLUMN review_runs.artifact_publication IS
  'Runner-reported publication status and reference for the terminal result artifact, when available.';
COMMENT ON COLUMN review_runs.workflow_result IS
  'Terminal successful workflow result returned by the Runner and consumed by the connector publisher.';
COMMENT ON COLUMN review_runs.preparation_claim_token IS
  'Fencing token held by the current input preparer; stale owners cannot save input or queue the run.';
COMMENT ON COLUMN review_runs.preparation_claimed_at IS
  'Last successful acquisition or renewal time for the current preparation claim, used to detect abandoned preparation.';
COMMENT ON COLUMN review_runs.recovery_claim_token IS
  'Fencing token held while reconciling a Runner submission whose acceptance was uncertain.';
COMMENT ON COLUMN review_runs.ingress_kind IS
  'Class of external request that admitted the run, used with ingress_key for replay deduplication.';
COMMENT ON COLUMN review_runs.ingress_key IS
  'Connector-supplied idempotency key for the external request, scoped by connector_id and ingress_kind.';
COMMENT ON COLUMN review_runs.created_at IS
  'Time the Control Plane durably admitted the run.';
COMMENT ON COLUMN review_runs.updated_at IS
  'Time the Runner-side lifecycle or retained Runner data last changed.';

CREATE INDEX review_runs_runner_status_idx
  ON review_runs (runner_status, updated_at);

-- Every run has one publication row. Keeping this state separate means a
-- successful review remains successful even if delivery to the connector fails.
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

COMMENT ON TABLE publications IS
  'Run-level state machine for publishing a successful workflow result through its connector.';
COMMENT ON COLUMN publications.run_id IS
  'Review run whose terminal workflow result is being published.';
COMMENT ON COLUMN publications.connector_id IS
  'Connector namespace allowed to claim and complete this publication.';
COMMENT ON COLUMN publications.status IS
  'Overall delivery state: pending, actively claimed, published, permanently failed, or not applicable.';
COMMENT ON COLUMN publications.claim_token IS
  'Fencing token held by the current publisher; all step and final-state writes require this owner.';
COMMENT ON COLUMN publications.claimed_at IS
  'Claim heartbeat time used to reclaim publication work after a publisher stops making progress.';
COMMENT ON COLUMN publications.failure_code IS
  'Machine-readable reason the overall publication failed or was returned for retry.';
COMMENT ON COLUMN publications.failure_message IS
  'Operator-readable detail associated with the publication failure.';
COMMENT ON COLUMN publications.published_at IS
  'Time all required connector side effects completed and the publication became terminally successful.';
COMMENT ON COLUMN publications.updated_at IS
  'Time the publication state, claim heartbeat, or failure information last changed.';

CREATE INDEX publications_status_idx
  ON publications (status, updated_at);

-- A publication may require several externally visible actions. Persisting each
-- action prevents a retry from repeating steps that already succeeded.
CREATE TABLE publication_steps (
  connector_id text NOT NULL,
  run_id text NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
  step_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'terminal_failed')),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  remote_object_id text,
  remote_object_url text,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connector_id, run_id, step_key)
);

COMMENT ON TABLE publication_steps IS
  'Per-side-effect progress for a connector publication, retained across claims and process restarts.';
COMMENT ON COLUMN publication_steps.connector_id IS
  'Connector namespace that owns the publication step.';
COMMENT ON COLUMN publication_steps.run_id IS
  'Review run whose publication contains this step.';
COMMENT ON COLUMN publication_steps.step_key IS
  'Stable connector-defined identity of one publication side effect within the run.';
COMMENT ON COLUMN publication_steps.status IS
  'Step lifecycle; terminal_failed means the retry budget was exhausted or retry was explicitly forbidden.';
COMMENT ON COLUMN publication_steps.failure_count IS
  'Number of failed executions recorded for this step; successful claims do not increment it.';
COMMENT ON COLUMN publication_steps.remote_object_id IS
  'Stable identifier returned by the external system after the side effect succeeds, used for reconciliation.';
COMMENT ON COLUMN publication_steps.remote_object_url IS
  'Operator-facing URL of the external object created or reused by the successful step.';
COMMENT ON COLUMN publication_steps.failure_code IS
  'Machine-readable reason for the most recent failed step execution.';
COMMENT ON COLUMN publication_steps.failure_message IS
  'Operator-readable detail for the most recent failed step execution.';
COMMENT ON COLUMN publication_steps.created_at IS
  'Time the connector fixed the publication step set for this run.';
COMMENT ON COLUMN publication_steps.updated_at IS
  'Time the step state, remote identity, or failure information last changed.';
