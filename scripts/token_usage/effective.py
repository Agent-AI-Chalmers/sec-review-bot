from dataclasses import replace

from .models import AttemptUsage, EffectivePatchUsage, RunUsage, StageUsage


def stage_by_name(run: RunUsage, stage_name: str) -> StageUsage | None:
    for stage in run.stages:
        if stage.stage == stage_name:
            return stage
    return None


def _attempts_for_stage(run: RunUsage, stage_name: str) -> list[AttemptUsage]:
    return [attempt for attempt in run.attempts if attempt.stage == stage_name]


def _final_stage_attempt(run: RunUsage, stage_name: str) -> AttemptUsage | None:
    stage = stage_by_name(run, stage_name)
    if stage is None:
        return None
    return AttemptUsage(stage=stage.stage, attempt_label="final", usage=stage)


def _initial_stage_attempt(run: RunUsage, stage_name: str) -> AttemptUsage | None:
    attempts = _attempts_for_stage(run, stage_name)
    if attempts:
        return attempts[0]
    return _final_stage_attempt(run, stage_name)


def compute_lightweight_two_stage_usage(run: RunUsage) -> EffectivePatchUsage:
    """Compute the derived analyzer + first mitigator usage used by lightweight-two-stage."""
    included = [
        item
        for item in (
            _final_stage_attempt(run, "analyzer"),
            _initial_stage_attempt(run, "mitigator"),
        )
        if item is not None
    ]
    return EffectivePatchUsage(included_attempts=included)


def compute_effective_patch_usage(run: RunUsage) -> EffectivePatchUsage:
    """Select recorded attempts; stage totals are derived views, not executions."""
    if run.workflow_kind == "repository-review-workflow-result":
        return EffectivePatchUsage(included_attempts=list(run.attempts))

    if run.workflow_kind == "issue-review-single-agent-workflow-result":
        return EffectivePatchUsage(
            included_attempts=_attempts_for_stage(run, "single-agent")
        )

    if run.workflow_kind == "issue-review-two-stage-workflow-result":
        return EffectivePatchUsage(
            included_attempts=[
                attempt
                for attempt in run.attempts
                if attempt.stage in {"analyzer", "mitigator"}
            ]
        )

    analyzer = _attempts_for_stage(run, "analyzer")
    mitigator = _attempts_for_stage(run, "mitigator")
    verifier = _attempts_for_stage(run, "verifier")
    # Verification that caused mitigation feedback is part of the patch path;
    # the final verification is inspection, not patch generation.
    feedback_count = max(len(mitigator) - 1, 0)
    return EffectivePatchUsage(
        included_attempts=analyzer[:1] + mitigator + verifier[:feedback_count]
    )


def effective_patch_efficiency(run: RunUsage) -> float | None:
    effective_total = compute_effective_patch_usage(run).totals.total_tokens
    total = run.total_tokens
    if total is None or effective_total is None:
        return None
    return effective_total / total if total > 0 else 0.0


def effective_patch_run(run: RunUsage) -> RunUsage:
    effective = compute_effective_patch_usage(run)
    return replace(run, stages=effective.stages, attempts=effective.included_attempts)


def lightweight_two_stage_run(run: RunUsage) -> RunUsage:
    effective = compute_lightweight_two_stage_usage(run)
    return replace(run, stages=effective.stages, attempts=effective.included_attempts)
