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
  UNIQUE (connector_id, ingress_kind, ingress_key),
  -- Redundant as a key (run_id is already unique) but required as a foreign-key target: the axis
  -- tables reference (run_id, connector_id) together so an axis row cannot claim a connector the
  -- trunk does not own.
  UNIQUE (run_id, connector_id)
);

COMMENT ON TABLE review_runs IS
  'Durable review identity: the externally admitted task and the fields that span all three lifecycle axes. Execution, preparation, and publication each keep their own state machine and their own input in executions, preparations, and publications.';
COMMENT ON COLUMN review_runs.run_id IS
  'Stable review identity assigned at admission, before preparation, execution, or publication begins, and shared with the Execution.';
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
-- externally claimable owner (Control Plane observes the Execution), so its claim token only
-- fences replay of an uncertain submission. It deliberately mirrors the axis shape:
-- run_id + connector_id + status + failure + claim/lease + timestamps.
CREATE TABLE executions (
  run_id text PRIMARY KEY,
  connector_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'queued', 'running', 'uncertain', 'disconnected', 'succeeded', 'skipped', 'failed')),
  input jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  failure_message text,
  artifact_storage jsonb,
  workflow_result jsonb,
  claim_token uuid,
  claimed_at timestamptz,
  -- How many recovery replays of an uncertain submission produced another unknown outcome. The
  -- axis stays `uncertain` on each such replay, so without a budget an Execution provider that keeps timing
  -- out would be replayed forever and the run would never reach a state anyone is told about.
  -- Named `attempt_count` like the other two axes: the name says what is counted (attempts), and
  -- each table has exactly one such counter, so the axis is the qualifier. Counted here rather
  -- than in memory because the lease lets a different process take over.
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A recovery claim exists only while the submission result is unknown: `claimSubmissionRecovery`
  -- takes it on `uncertain`, and every path that leaves `uncertain` clears it. Pinning that to the
  -- status mirrors `preparations`, which ties its token to `preparing`. The implication is one-way
  -- on purpose: an `uncertain` row has no claim until a recovery takes one, but no other state may
  -- hold a token at all. Without this, a `queued` or `succeeded` row could keep a token no read
  -- path expects, and it would only surface later as a stale recovery lease.
  CHECK (
    (claim_token IS NULL AND claimed_at IS NULL)
    OR (
      status = 'uncertain'
      AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  ),
  -- The start/end pair is the phase's own timing, so its presence is pinned to the status
  -- rather than left to each UPDATE. `pending` and `uncertain` have neither: the input has not
  -- been accepted, so execution has not begun. `queued` and `running` are in flight, so they
  -- have a start and no end.
  --
  -- A terminal state can be end-only. `skipped` never ran at all (preparation failed before the
  -- Execution was called), and `failed` reaches that shape when a replay of an uncertain submission
  -- is rejected: the Execution never accepted it, so execution still never began. Both conclude the
  -- axis without a start, which is why a measured duration requires started_at to be non-null.
  CHECK (
    CASE status
      WHEN 'pending' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'uncertain' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'disconnected' THEN started_at IS NULL AND finished_at IS NULL
      WHEN 'queued' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL
      ELSE finished_at IS NOT NULL
    END
  ),
  -- An axis row belongs to the connector that owns its run. Without this, a row written under the
  -- wrong connector would be invisible to the reads that join on connector_id, and would surface
  -- as a "missing axis" corruption instead of a rejected write.
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE
);

COMMENT ON TABLE executions IS
  'Run-level state machine for Execution submission and execution. One row per run, created at admission.';
COMMENT ON COLUMN executions.status IS
  'Execution-side lifecycle only: pending until the prepared input is submitted, then active execution. uncertain means a submission may have reached the Execution provider and automation is retrying the idempotent request. disconnected means that retry budget is exhausted and automation has stopped without asserting failure; an operator must resume recovery or explicitly abandon the run. skipped means execution never ran because preparation failed.';
COMMENT ON COLUMN executions.input IS
  'Prepared Execution request, including artifact references. Retained so an uncertain submission can be replayed safely.';
COMMENT ON COLUMN executions.started_at IS
  'Immutable instant the prepared Execution input was accepted and execution began, i.e. the execution axis start. NULL until then, and also NULL for a skipped execution, which is concluded without ever having started. Written once and never moved, so a recovery replay cannot shorten a measured duration. Named to match preparations.started_at and publications.started_at: each axis ends its phase in finished_at.';
COMMENT ON COLUMN executions.finished_at IS
  'Immutable instant the execution axis reached a terminal state (succeeded, failed, or skipped); NULL while it is still pending, queued, running, or uncertain. Written once, in the same UPDATE that sets the terminal status. Distinct from observed_at, which also moves on every successful poll and therefore cannot mark the phase end. skipped deliberately has an end but no started_at: preparation failed before the Execution was called, so the axis is concluded without ever having started, and finished_at - started_at is only meaningful when started_at is non-null.';
COMMENT ON COLUMN executions.failure_code IS
  'Machine-readable reason for a submission, polling, or execution failure; NULL when preparation failed instead (see preparations.failure_code).';
COMMENT ON COLUMN executions.failure_message IS
  'Operator-readable detail associated with failure_code.';
COMMENT ON COLUMN executions.artifact_storage IS
  'Execution-reported terminal diagnostic artifact storage result and immutable object reference when available.';
COMMENT ON COLUMN executions.workflow_result IS
  'Terminal successful workflow result returned by the Execution and consumed by the connector publisher.';
COMMENT ON COLUMN executions.claim_token IS
  'Fencing token held while reconciling an Execution submission whose acceptance was uncertain. Not a long-running lease: the replay is short and the Execution provider owns request idempotency.';
COMMENT ON COLUMN executions.claimed_at IS
  'When the current recovery claim was taken; a stale claim is reclaimed after the claim timeout.';
COMMENT ON COLUMN executions.attempt_count IS
  'Number of recovery replays that ended with the outcome still unknown. The row stays uncertain on each one; when this reaches the recovery budget it becomes disconnected, stopping automation without asserting that the Execution did not accept the run. Automatic work never clears it - that is what bounds a run''s automatic recovery rather than one owner''s tenure - and only an operator resume resets it, which grants a fresh budget by design.';
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
  status text NOT NULL CHECK (status IN ('pending', 'preparing', 'uncertain', 'disconnected', 'submitted', 'failed')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- The failure fields describe the current attempt while it is in flight and the reason the
  -- row cannot continue once it is terminal. A claim clears them for the new attempt, so they
  -- cannot be the place a lease expiry looks for "what went wrong last time"; that is
  -- last_failure_code / last_failure_message below.
  failure_code text,
  failure_message text,
  last_failure_code text,
  last_failure_message text,
  started_at timestamptz,
  finished_at timestamptz,
  -- Why preparation is `disconnected`: automatic work stopped without reaching a conclusion, and
  -- only a person can decide what happens next. It is a durable "do not retry this by itself"
  -- record: without it, every coordination pass would select the same row, fail the same way, and
  -- roll back, so a single stuck run would starve every other run in the pass. NULL in every
  -- other state, which the CHECK below pins.
  disconnect_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'preparing' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'preparing' AND claim_token IS NULL AND claimed_at IS NULL)
  ),
  -- Only a disconnected row carries a reason, and a disconnected row always carries one.
  CHECK ((status = 'disconnected') = (disconnect_reason IS NOT NULL)),
  -- A preparation that has ever been claimed keeps its start even after a retry or an expired
  -- lease returns it to `pending`, because the phase really did begin; only a never-claimed row
  -- has no start. Every non-pending state therefore implies a start, and only the terminal ones
  -- carry an end.
  CHECK (
    CASE status
      WHEN 'pending' THEN finished_at IS NULL
      WHEN 'preparing' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'uncertain' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'disconnected' THEN started_at IS NOT NULL AND finished_at IS NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL
    END
  ),
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE,
  -- Foreign-key target for the notice outbox, which belongs to the same connector as
  -- the preparation it reports on.
  UNIQUE (run_id, connector_id)
);

COMMENT ON TABLE preparations IS
  'Provider-neutral, durable preparation work for one review run. Connectors own how work is reconstructed and executed.';
COMMENT ON COLUMN preparations.run_id IS
  'Review run whose Execution input is being prepared.';
COMMENT ON COLUMN preparations.connector_id IS
  'Connector namespace allowed to claim and complete this preparation.';
COMMENT ON COLUMN preparations.input_version IS
  'Connector-defined version of input. Control Plane treats the input as opaque.';
COMMENT ON COLUMN preparations.input IS
  'Connector-owned, replayable preparation input. It contains no Control Plane-defined provider fields.';
COMMENT ON COLUMN preparations.status IS
  'Preparation lifecycle: pending (waiting for a preparer), preparing (a preparer currently owns the claim), uncertain (the claim lapsed and it is unknown whether the prepared input reached the Control Plane), disconnected (automatic work stopped without a conclusion; a person must decide), submitted (input handed to the Execution), failed (terminal). An expired claim returns to uncertain, never to pending; expiry after the retry budget is exhausted is terminal.';
COMMENT ON COLUMN preparations.available_at IS
  'Earliest time a pending preparation may be claimed. Retry backoff is durable so a process restart cannot bypass it.';
COMMENT ON COLUMN preparations.claim_token IS
  'Fencing token held by the current preparer; stale owners cannot save input or queue the run.';
COMMENT ON COLUMN preparations.claimed_at IS
  'Last acquisition or renewal time for the current preparation claim.';
COMMENT ON COLUMN preparations.attempt_count IS
  'Number of claims taken, including the one admission makes. A claim is counted when it is taken, not when it succeeds, so a failed or expired attempt still advances this value: it is the budget MAX_PREPARATION_ATTEMPTS is compared against, and the attempt number handed to the connector for its retry policy.';
COMMENT ON COLUMN preparations.failure_code IS
  'Machine-readable reason for the current failure: set by a retryable failure or by a terminal one, and cleared when the work is claimed again. NULL while an attempt is in flight and has not failed.';
COMMENT ON COLUMN preparations.failure_message IS
  'Operator-readable detail associated with failure_code. Cleared together with it on a new claim.';
COMMENT ON COLUMN preparations.last_failure_code IS
  'Most recent failure recorded by any attempt, kept across re-claims because a claim clears failure_code. A lease expiry that exhausts the retry budget reports this instead of the generic exhaustion code, so the last real reason survives the gap between a failure and the row dying on its next lease.';
COMMENT ON COLUMN preparations.last_failure_message IS
  'Operator-readable detail associated with last_failure_code, kept across re-claims for the same reason.';
COMMENT ON COLUMN preparations.started_at IS
  'Immutable instant a preparer first claimed this work, i.e. the preparation phase began; NULL while it is still pending. Written once, so a retry that returns the row to pending and claims it again does not move it. Distinct from claimed_at, which is the current lease and is renewed on every heartbeat.';
COMMENT ON COLUMN preparations.finished_at IS
  'Immutable instant the preparation axis reached a terminal state (submitted or failed); NULL while it is pending, preparing, uncertain, or disconnected. Written once, in the same UPDATE that sets the terminal status. Distinct from updated_at, which also moves on claim heartbeats and input checkpoints and therefore cannot mark the phase end.';
COMMENT ON COLUMN preparations.disconnect_reason IS
  'Why preparation is `disconnected`: the automatic path stopped without a conclusion and a person must decide. Non-NULL means coordination deliberately skips this row instead of retrying a transition that must keep failing. Cleared when an operator resumes the row into `uncertain`, or concludes it.';

CREATE INDEX preparations_claimable_idx
  ON preparations (connector_id, status, available_at, updated_at);

-- A disconnected row is excluded from the claimable index's predicate; this one finds the rows
-- an operator still has to act on, without scanning every pending preparation.
CREATE INDEX preparations_disconnected_idx
  ON preparations (connector_id, updated_at)
  WHERE status = 'disconnected';

-- A terminal preparation failure may need connector-facing acknowledgement after
-- the preparer has died. This outbox is deliberately provider-neutral: it stores
-- delivery ownership only, while connectors interpret the preparation input.
CREATE TABLE run_notices (
  -- A notice is one user-visible consequence of one coordination event. A run can therefore
  -- have several notices over time (for example, recover then later become disconnected again).
  notice_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('failure', 'attention')),
  -- The transition event is appended in the same transaction and is the idempotency key.
  -- The foreign key is added after review_run_events below because this is the initial schema.
  source_event_id bigint UNIQUE,
  -- `failed` rather than `skipped` for a delivery that did not happen: the connector tried and
  -- could not reach the provider, which is a failure, not a decision to skip. Sharing `skipped`
  -- with the other axes made it indistinguishable from "this notice did not apply".
  status text NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  axis text NOT NULL CHECK (axis IN ('preparation', 'execution', 'publication')),
  -- The reason is captured when the notice is created, not read back at delivery time: the axis
  -- row is a live state machine that a later retry may rewrite, while the notice exists to report
  -- one specific conclusion.
  reason_code text,
  -- Where the connector posted the acknowledgement. Recorded on delivery rather than derived:
  -- the comment's URL is only known once GitHub answers, and a reader needs to open the exact
  -- comment rather than the issue it sits on. Null while undelivered and when delivery failed.
  comment_url text,
  claim_token uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'delivering' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'delivering' AND claim_token IS NULL AND claimed_at IS NULL)
  ),
  -- The notice is read by joining on connector_id, so a notice stored under a connector the run
  -- does not belong to would make `notices_status` read as null instead of surfacing as a
  -- bad write. The composite key below replaces the single-column one above for this purpose:
  -- `run_id` alone would already be satisfied, and the pair is what the join actually means.
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE
);
COMMENT ON TABLE run_notices IS
  'Provider-neutral outbox for user-visible failure and attention notices caused by coordination events.';
COMMENT ON COLUMN run_notices.axis IS
  'Lifecycle axis whose event caused this notice.';
COMMENT ON COLUMN run_notices.reason_code IS
  'Event reason captured at creation, so delivery reports the original conclusion rather than re-reading mutable snapshot state.';
CREATE INDEX run_notices_claimable_idx
  ON run_notices (connector_id, status, updated_at);

-- Every run has one publication row. Keeping this state separate means a
-- successful review remains successful even if delivery to the connector fails.
CREATE TABLE publications (
  run_id text PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'publishing', 'uncertain', 'disconnected', 'published', 'failed', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  failure_code text,
  failure_message text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, run_id),
  -- `pending` has no end, but may have a start: a retryable failure returns the row to pending
  -- while the phase is still running. `uncertain` and `disconnected` are mid-phase for the same
  -- reason: they say something about one step, not that the phase ended. `skipped` has an end and
  -- may have no start, because execution can fail before there was ever anything to publish.
  CHECK (
    CASE status
      WHEN 'pending' THEN finished_at IS NULL
      WHEN 'publishing' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'uncertain' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'disconnected' THEN started_at IS NOT NULL AND finished_at IS NULL
      WHEN 'skipped' THEN finished_at IS NOT NULL
      ELSE started_at IS NOT NULL AND finished_at IS NOT NULL
    END
  ),
  -- Publication is read with an inner join, so a row under the wrong connector would drop the
  -- whole run from every read rather than merely hiding the axis.
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE
);

COMMENT ON TABLE publications IS
  'Run-level state machine for publishing a successful workflow result through its connector.';
COMMENT ON COLUMN publications.run_id IS
  'Review run whose terminal workflow result is being published.';
COMMENT ON COLUMN publications.connector_id IS
  'Connector namespace allowed to claim and complete this publication.';
COMMENT ON COLUMN publications.input IS
  'Connector-owned publish context, such as repository and pull request identity; it selects the publication target and is never sent to the Execution.';
COMMENT ON COLUMN publications.status IS
  'Overall delivery state: pending (no publisher yet), publishing (a publisher owns it), uncertain (a step may have taken effect remotely and is being reconciled), disconnected (automatic reconciliation stopped; an operator must decide), published, permanently failed, or not applicable.';
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
  run_id text NOT NULL,
  step_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'uncertain', 'disconnected', 'succeeded', 'failed', 'terminal_failed')),
  -- How many times this step has been claimed, and when the latest claim began. A step that is
  -- found `running` belongs to a publisher that died mid-effect: the new owner cannot tell from
  -- the status alone whether the side effect already happened. These two columns make that
  -- knowable (`attempt_count > 1` means an earlier owner started it), so the connector can
  -- reconcile against the remote object instead of blindly repeating the call. They are
  -- diagnostics, not a lease: publication ownership still comes from `publications.claim_token`.
  --
  -- This is also the step's retry budget, compared against MAX_PUBLICATION_STEP_ATTEMPTS. Budget
  -- and "has anyone started this" are deliberately the same number: an attempt that began is an
  -- attempt spent, whether it ended in a recorded failure or in a publisher that vanished. There
  -- is no separate failure counter, because a failure total is derivable from the `failed`
  -- transitions recorded on this row, and a second maintained counter could drift from them.
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  recovery_attempt_count integer NOT NULL DEFAULT 0 CHECK (recovery_attempt_count >= 0),
  last_attempt_at timestamptz,
  -- The publication token that took the current attempt, so a reclaim can tell "a different
  -- owner is taking over a step the previous owner left running" from "this owner is claiming the
  -- step it already holds". Without it the second case would look identical to the first: a step
  -- left `running` is claimable, so the same owner calling twice would silently start a second
  -- attempt and corrupt the attempt count that reconciliation depends on. NULL while the step has
  -- not been claimed, or once it reached a terminal state.
  claimed_by uuid,
  remote_object_id text,
  remote_object_url text,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connector_id, run_id, step_key),
  -- Steps are read and completed under the connector that owns the run, so a row written under a
  -- different connector would be invisible to those reads instead of being rejected. Reference
  -- (run_id, connector_id) together so the trunk decides which connector may own a step.
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE
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
  'Step lifecycle. running is an active publisher-owned side effect; uncertain is a prior side effect whose remote outcome is being reconciled; disconnected means automatic reconciliation stopped without an outcome and needs operator action; terminal_failed requires a confirmed absence or deterministic rejection.';
COMMENT ON COLUMN publication_steps.claimed_by IS
  'Publication token that owns the current running attempt. A step may be reclaimed only when this differs from the caller''s token, so an owner cannot start a second attempt on a step it already holds.';
COMMENT ON COLUMN publication_steps.attempt_count IS
  'How many times this step has been claimed and started, and the step''s retry budget: a failed step is claimable again only while this is below MAX_PUBLICATION_STEP_ATTEMPTS. More than one means an earlier owner began the side effect, so a new owner must reconcile against the remote object instead of assuming nothing happened. An attempt counts once it begins, so an owner that died before recording anything still spent one.';
COMMENT ON COLUMN publication_steps.recovery_attempt_count IS
  'How many automatic remote reconciliations of an uncertain step did not yield a conclusive answer. It is separate from attempt_count because reads do not spend permission to repeat the external write. Reaching the recovery budget moves the step to disconnected.';
COMMENT ON COLUMN publication_steps.last_attempt_at IS
  'When the latest claim of this step started; NULL until it is claimed once. Together with attempt_count it distinguishes a never-started step from one whose owner died mid-effect.';
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
-- an audit trail. It deliberately records only Control Plane coordination axes: the Execution's
-- own execution history lives in Temporal and is not duplicated here.
CREATE TABLE review_run_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL,
  connector_id text NOT NULL,
  axis text NOT NULL CHECK (axis IN ('execution', 'preparation', 'publication')),
  from_status text,
  to_status text NOT NULL,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Events are read with a connector filter, so a row under the wrong connector would silently
  -- vanish from the run's history. Tie the append to the trunk's connector so that write fails.
  FOREIGN KEY (run_id, connector_id)
    REFERENCES review_runs (run_id, connector_id) ON DELETE CASCADE
);

COMMENT ON TABLE review_run_events IS
  'Append-only audit log of coordination-side state transitions. Read by operators; the snapshot tables remain the current-state truth.';
COMMENT ON COLUMN review_run_events.run_id IS
  'Review run whose coordination state changed.';
COMMENT ON COLUMN review_run_events.connector_id IS
  'Connector namespace that owns the run, kept so reads can be fenced per connector.';
COMMENT ON COLUMN review_run_events.axis IS
  'Which coordination state machine the transition belongs to: execution, preparation, publication, or notice.';
COMMENT ON COLUMN review_run_events.from_status IS
  'State before the transition; NULL for the first event on an axis (for example admission).';
COMMENT ON COLUMN review_run_events.to_status IS
  'State after the transition.';
COMMENT ON COLUMN review_run_events.reason_code IS
  'Machine-readable cause for a failure or reversion transition, when there is one.';
COMMENT ON COLUMN review_run_events.occurred_at IS
  'Time the transition was recorded, written in the same transaction as the snapshot update.';

ALTER TABLE run_notices
  ADD CONSTRAINT run_notices_source_event_id_fkey
  FOREIGN KEY (source_event_id) REFERENCES review_run_events (event_id) ON DELETE CASCADE;

CREATE INDEX review_run_events_run_idx
  ON review_run_events (run_id, occurred_at);
