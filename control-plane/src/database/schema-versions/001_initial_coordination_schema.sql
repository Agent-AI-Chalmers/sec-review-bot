-- The durable review trunk: one row per admitted task, carrying only its identity and the
-- fields shared across all three lifecycle axes. Execution, preparation, and publication each
-- keep their own state machine in executions, preparations, and publications.
CREATE TABLE review_runs (
  run_id text PRIMARY KEY,
  connector_id text NOT NULL,
  workflow text NOT NULL,
  ingress_kind text,
  ingress_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, ingress_kind, ingress_key)
);

COMMENT ON TABLE review_runs IS
  'Durable review identity: the externally admitted task and the fields that span all three lifecycle axes. Execution, preparation, and publication each keep their own state machine and their own input in executions, preparations, and publications.';
COMMENT ON COLUMN review_runs.run_id IS
  'Stable review identity assigned at admission, before preparation, execution, or publication begins, and shared with the Runner.';
COMMENT ON COLUMN review_runs.connector_id IS
  'Coordination namespace that owns the run, such as one configured GitHub App connector.';
COMMENT ON COLUMN review_runs.workflow IS
  'Workflow contract used to validate, submit, observe, and publish this review.';
COMMENT ON COLUMN review_runs.ingress_kind IS
  'Class of external request that admitted the run, used with ingress_key for replay deduplication.';
COMMENT ON COLUMN review_runs.ingress_key IS
  'Connector-supplied idempotency key for the external request, scoped by connector_id and ingress_kind.';
COMMENT ON COLUMN review_runs.created_at IS
  'Time the Control Plane durably admitted the run.';
COMMENT ON COLUMN review_runs.updated_at IS
  'Row mtime for the trunk row: last time identity metadata or an ingress checkpoint changed. Lifetime progress and per-axis input live on the axis tables.';

-- Execution is the third lifecycle axis, alongside preparation and publication. It has no
-- externally claimable owner (Control Plane observes the Runner), so its claim token only
-- fences replay of an uncertain submission. It deliberately mirrors the axis shape:
-- run_id + connector_id + status + failure + claim/lease + timestamps.
CREATE TABLE executions (
  run_id text PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'queued', 'running', 'uncertain', 'succeeded', 'skipped', 'failed')),
  input jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_message text,
  artifact_storage jsonb,
  workflow_result jsonb,
  claim_token uuid,
  claimed_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (claim_token IS NULL AND claimed_at IS NULL)
    OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  -- The start/end pair is the phase's own timing, so its presence is pinned to the status
  -- rather than left to each UPDATE. `pending` and `uncertain` have neither: the input has not
  -- been accepted, so execution has not begun. `queued` and `running` are in flight, so they
  -- have a start and no end.
  --
  -- A terminal state can be end-only. `skipped` never ran at all (preparation failed before the
  -- Runner was called), and `failed` reaches that shape when a replay of an uncertain submission
  -- is rejected: the Runner never accepted it, so execution still never began. Both conclude the
  -- axis without a start, which is why a measured duration requires started_at to be non-null.
  CHECK (
    CASE status
      WHEN 'pending' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'uncertain' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'queued' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL
      ELSE finished_at IS NOT NULL
    END
  )
);

COMMENT ON TABLE executions IS
  'Run-level state machine for Runner submission and execution. One row per run, created at admission.';
COMMENT ON COLUMN executions.status IS
  'Runner-side lifecycle only: pending until the prepared input is submitted, then Runner execution. uncertain means a submission may have reached the Runner but its result could not be confirmed — it is not a failure; a recovery replays the same run_id under claim_token to resolve it, then the run becomes queued or failed. skipped means execution never ran because preparation failed.';
COMMENT ON COLUMN executions.input IS
  'Prepared Runner request, including artifact references. Retained so an uncertain submission can be replayed safely.';
COMMENT ON COLUMN executions.started_at IS
  'Immutable instant the prepared Runner input was accepted and execution began, i.e. the execution axis start. NULL until then, and also NULL for a skipped execution, which is concluded without ever having started. Written once and never moved, so a recovery replay cannot shorten a measured duration. Named to match preparations.started_at and publications.started_at: each axis ends its phase in finished_at.';
COMMENT ON COLUMN executions.finished_at IS
  'Immutable instant the execution axis reached a terminal state (succeeded, failed, or skipped); NULL while it is still pending, queued, running, or uncertain. Written once, in the same UPDATE that sets the terminal status. Distinct from observed_at, which also moves on every successful poll and therefore cannot mark the phase end. skipped deliberately has an end but no started_at: preparation failed before the Runner was called, so the axis is concluded without ever having started, and finished_at - started_at is only meaningful when started_at is non-null.';
COMMENT ON COLUMN executions.failure_code IS
  'Machine-readable reason for a submission, polling, or Runner execution failure; NULL when preparation failed instead (see preparations.failure_code).';
COMMENT ON COLUMN executions.failure_message IS
  'Operator-readable detail associated with failure_code.';
COMMENT ON COLUMN executions.artifact_storage IS
  'Runner-reported terminal diagnostic artifact storage result and immutable object reference when available.';
COMMENT ON COLUMN executions.workflow_result IS
  'Terminal successful workflow result returned by the Runner and consumed by the connector publisher.';
COMMENT ON COLUMN executions.claim_token IS
  'Fencing token held while reconciling a Runner submission whose acceptance was uncertain. Not a long-running lease: the replay is short and the Runner owns request idempotency.';
COMMENT ON COLUMN executions.claimed_at IS
  'When the current recovery claim was taken; a stale claim is reclaimed after the claim timeout.';
COMMENT ON COLUMN executions.observed_at IS
  'Last time polling successfully confirmed the run state. Informational: it never drives claim expiry.';
COMMENT ON COLUMN executions.created_at IS
  'Time the execution axis was created with the run at admission.';
COMMENT ON COLUMN executions.updated_at IS
  'Time any execution-axis column last changed.';

CREATE INDEX executions_status_idx
  ON executions (status, updated_at);

CREATE INDEX executions_recovery_idx
  ON executions (connector_id, status, claimed_at);

-- Preparation is a separately claimable unit of work. Its protocol deliberately
-- contains no provider-specific columns: connectors own the interpretation of
-- their preparation inputs and the external side effects used to construct them.
CREATE TABLE preparations (
  run_id text PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  input_version text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'preparing', 'submitted', 'failed')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_code text,
  failure_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'preparing' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'preparing' AND claim_token IS NULL AND claimed_at IS NULL)
  ),
  -- A preparation that has ever been claimed keeps its start even after a retry or an expired
  -- lease returns it to `pending`, because the phase really did begin; only a never-claimed row
  -- has no start. Every non-pending state therefore implies a start, and only the terminal ones
  -- carry an end.
  CHECK (
    CASE status
      WHEN 'pending' THEN finished_at IS NULL
      WHEN 'preparing' THEN started_at IS NOT NULL AND finished_at IS NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL
    END
  )
);

COMMENT ON TABLE preparations IS
  'Provider-neutral, durable preparation work for one review run. Connectors own how work is reconstructed and executed.';
COMMENT ON COLUMN preparations.run_id IS
  'Review run whose Runner input is being prepared.';
COMMENT ON COLUMN preparations.connector_id IS
  'Connector namespace allowed to claim and complete this preparation.';
COMMENT ON COLUMN preparations.input_version IS
  'Connector-defined version of input. Control Plane treats the input as opaque.';
COMMENT ON COLUMN preparations.input IS
  'Connector-owned, replayable preparation input. It contains no Control Plane-defined provider fields.';
COMMENT ON COLUMN preparations.status IS
  'Preparation lifecycle: pending (waiting for a preparer), preparing (a preparer currently owns the claim), submitted (input handed to the Runner), failed (terminal). An expired claim normally returns to pending; expiry after the retry budget is exhausted is terminal.';
COMMENT ON COLUMN preparations.available_at IS
  'Earliest time a pending preparation may be claimed. Retry backoff is durable so a process restart cannot bypass it.';
COMMENT ON COLUMN preparations.claim_token IS
  'Fencing token held by the current preparer; stale owners cannot save input or queue the run.';
COMMENT ON COLUMN preparations.claimed_at IS
  'Last acquisition or renewal time for the current preparation claim.';
COMMENT ON COLUMN preparations.attempt_count IS
  'Number of successful claims. It is retained for connector retry policy and observability.';
COMMENT ON COLUMN preparations.failure_code IS
  'Connector-supplied machine-readable terminal preparation failure reason.';
COMMENT ON COLUMN preparations.failure_message IS
  'Connector-supplied operator-readable terminal preparation failure detail.';
COMMENT ON COLUMN preparations.started_at IS
  'Immutable instant a preparer first claimed this work, i.e. the preparation phase began; NULL while it is still pending. Written once, so a retry that returns the row to pending and claims it again does not move it. Distinct from claimed_at, which is the current lease and is renewed on every heartbeat.';
COMMENT ON COLUMN preparations.finished_at IS
  'Immutable instant the preparation axis reached a terminal state (submitted or failed); NULL while it is pending or preparing. Written once, in the same UPDATE that sets the terminal status. Distinct from updated_at, which also moves on claim heartbeats and input checkpoints and therefore cannot mark the phase end.';

CREATE INDEX preparations_claimable_idx
  ON preparations (connector_id, status, available_at, updated_at);

-- A terminal preparation failure may need connector-facing acknowledgement after
-- the preparer has died. This outbox is deliberately provider-neutral: it stores
-- delivery ownership only, while connectors interpret the preparation input.
CREATE TABLE preparation_failure_notices (
  run_id text PRIMARY KEY REFERENCES preparations(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'delivering' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'delivering' AND claim_token IS NULL AND claimed_at IS NULL)
  )
);
COMMENT ON TABLE preparation_failure_notices IS
  'Provider-neutral outbox for connector acknowledgement of terminal preparation failures.';
CREATE INDEX preparation_failure_notices_claimable_idx
  ON preparation_failure_notices (connector_id, status, updated_at);

-- Every run has one publication row. Keeping this state separate means a
-- successful review remains successful even if delivery to the connector fails.
CREATE TABLE publications (
  run_id text PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  failure_code text,
  failure_message text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, run_id),
  -- `pending` has no end, but may have a start: a retryable failure returns the row to pending
  -- while the phase is still running. `skipped` has an end and may have no start, because
  -- execution can fail before there was ever anything to publish.
  CHECK (
    CASE status
      WHEN 'pending' THEN finished_at IS NULL
      WHEN 'publishing' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'skipped' THEN finished_at IS NOT NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL
    END
  )
);

COMMENT ON TABLE publications IS
  'Run-level state machine for publishing a successful workflow result through its connector.';
COMMENT ON COLUMN publications.run_id IS
  'Review run whose terminal workflow result is being published.';
COMMENT ON COLUMN publications.connector_id IS
  'Connector namespace allowed to claim and complete this publication.';
COMMENT ON COLUMN publications.input IS
  'Connector-owned publish context, such as repository and pull request identity; it selects the publication target and is never sent to the Runner.';
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
COMMENT ON COLUMN publications.started_at IS
  'Immutable instant the publication was first claimed and began publishing; NULL while it is still pending or was skipped before it started. Written once, so a retryable failure that returns the row to pending and claims it again does not move it. Distinct from claimed_at, which is the current lease and is renewed on every heartbeat.';
COMMENT ON COLUMN publications.finished_at IS
  'Immutable instant the publication axis reached a terminal state (published, failed, or skipped), in the same statement that sets the terminal status. Together with started_at it times the phase; for a skipped publication started_at is NULL because the phase never began. The successful instant is finished_at read together with status = published; a separate published_at column would hold the same value on every successful row and nothing on the others.';
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

-- Append-only log of coordination-side state transitions, so an operator can see how a
-- run reached its current state instead of reconstructing it from row mtimes or process
-- logs. The live snapshot tables above remain the source of truth for "now"; this table is
-- an audit trail. It deliberately records only Control Plane coordination axes: the Runner's
-- own execution history lives in Temporal and is not duplicated here.
CREATE TABLE review_run_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  axis text NOT NULL CHECK (axis IN ('runner', 'preparation', 'publication', 'notice')),
  from_status text,
  to_status text NOT NULL,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE review_run_events IS
  'Append-only audit log of coordination-side state transitions. Read by operators; the snapshot tables remain the current-state truth.';
COMMENT ON COLUMN review_run_events.run_id IS
  'Review run whose coordination state changed.';
COMMENT ON COLUMN review_run_events.connector_id IS
  'Connector namespace that owns the run, kept so reads can be fenced per connector.';
COMMENT ON COLUMN review_run_events.axis IS
  'Which coordination state machine the transition belongs to: runner, preparation, publication, or notice.';
COMMENT ON COLUMN review_run_events.from_status IS
  'State before the transition; NULL for the first event on an axis (for example admission).';
COMMENT ON COLUMN review_run_events.to_status IS
  'State after the transition.';
COMMENT ON COLUMN review_run_events.reason_code IS
  'Machine-readable cause for a failure or reversion transition, when there is one.';
COMMENT ON COLUMN review_run_events.occurred_at IS
  'Time the transition was recorded, written in the same transaction as the snapshot update.';

CREATE INDEX review_run_events_run_idx
  ON review_run_events (run_id, occurred_at);
