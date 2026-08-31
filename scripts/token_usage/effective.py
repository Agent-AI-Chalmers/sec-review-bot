from .models import AttemptUsage, EffectivePatchUsage, RunUsage, StageUsage

STAGE_ALIASES = {
    "analyzer": ("analyzer", "analysis"),
    "mitigator": ("mitigator", "mitigation"),
    "verifier": ("verifier", "verification"),
    "single-agent": ("single-agent",),
}


def _stage_aliases(stage_name: str) -> tuple[str, ...]:
    return STAGE_ALIASES.get(stage_name, (stage_name,))


def stage_by_name(run: RunUsage, stage_name: str) -> StageUsage | None:
    aliases = set(_stage_aliases(stage_name))
    for stage in run.stages:
        if stage.stage in aliases:
            return stage
    return None


def _attempts_for_stage(run: RunUsage, stage_name: str) -> list[AttemptUsage]:
    aliases = set(_stage_aliases(stage_name))
    return [attempt for attempt in run.attempts if attempt.stage in aliases]


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
    """Compute the derived analyzer + first mitigator cost used by lightweight-two-stage."""
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
    """Compute patch-generation usage.

    Semantics:
    - single-agent: all single-agent attempts/stage usage.
    - two-stage: final analyzer + final mitigator.
    - default/3-stage:
      * analyzer initial/final first pass;
      * all mitigator attempts;
      * verifier attempts only when they are part of retry feedback path.
    """

    if run.workflow_kind == "repository-review-workflow-result":
        return EffectivePatchUsage(
            included_attempts=[
                AttemptUsage(stage=stage.stage, attempt_label="final", usage=stage)
                for stage in run.stages
            ]
        )

    if run.workflow_kind == "issue-review-single-agent-workflow-result":
        single_attempts = _attempts_for_stage(run, "single-agent")
        if single_attempts:
            return EffectivePatchUsage(included_attempts=list(single_attempts))
        fallback = _final_stage_attempt(run, "single-agent")
        return EffectivePatchUsage(
            included_attempts=[fallback] if fallback is not None else []
        )

    if run.workflow_kind == "issue-review-two-stage-workflow-result":
        included = [
            item
            for item in (
                _final_stage_attempt(run, "analyzer"),
                _final_stage_attempt(run, "mitigator"),
            )
            if item is not None
        ]
        return EffectivePatchUsage(included_attempts=included)

    included: list[AttemptUsage] = []

    analyzer_attempts = _attempts_for_stage(run, "analyzer")
    if analyzer_attempts:
        included.append(analyzer_attempts[0])
    else:
        analyzer_fallback = _final_stage_attempt(run, "analyzer")
        if analyzer_fallback is not None:
            included.append(analyzer_fallback)

    mitigator_attempts = _attempts_for_stage(run, "mitigator")
    verifier_attempts = _attempts_for_stage(run, "verifier")

    if not mitigator_attempts:
        mitigator_fallback = _final_stage_attempt(run, "mitigator")
        if mitigator_fallback is not None and (
            run.retry_count_used == 0 or run.retry_count_used is None
        ):
            included.append(mitigator_fallback)
        return EffectivePatchUsage(included_attempts=included)

    included.extend(mitigator_attempts)

    # If there were N mitigator attempts, there were at most N-1 verifier feedback
    # checks that caused retry mitigation. Include only those verifier attempts in
    # effective_patch, not the final verifier-only cost.
    retry_mitigator_count = max(len(mitigator_attempts) - 1, 0)
    included.extend(verifier_attempts[:retry_mitigator_count])
    return EffectivePatchUsage(included_attempts=included)


def effective_patch_efficiency(run: RunUsage) -> float:
    return (
        compute_effective_patch_usage(run).totals.total_tokens / run.total_tokens
        if run.total_tokens > 0
        else 0.0
    )


def effective_patch_run(run: RunUsage) -> RunUsage:
    effective = compute_effective_patch_usage(run)
    return RunUsage(
        run_dir=run.run_dir,
        experiment=run.experiment,
        workflow_kind=run.workflow_kind,
        retry_count_used=run.retry_count_used,
        stages=effective.stages,
        attempts=[],
    )


def lightweight_two_stage_run(run: RunUsage) -> RunUsage:
    effective = compute_lightweight_two_stage_usage(run)
    return RunUsage(
        run_dir=run.run_dir,
        experiment=run.experiment,
        workflow_kind=run.workflow_kind,
        retry_count_used=run.retry_count_used,
        stages=effective.stages,
        attempts=[],
    )
