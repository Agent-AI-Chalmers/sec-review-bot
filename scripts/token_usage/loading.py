import json
from pathlib import Path
from typing import Any

from .models import AttemptUsage, RunUsage, StageUsage
from .normalization import (
    usage_from_langchain_metadata,
    usage_from_provider_metadata,
)

NUMERIC_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_read_tokens",
    "reasoning_tokens",
)
PASS_STAGE_DIRS = {"triage", "delivery-planning"}


def _artifact_root(run_dir: Path) -> Path:
    if run_dir.name == "artifacts":
        return run_dir
    candidate = run_dir / "artifacts" / run_dir.name
    if candidate.exists():
        return candidate
    return run_dir / "artifacts"


def _detect_workflow_metadata(run_dir: Path) -> tuple[str | None, int | None]:
    artifact_root = _artifact_root(run_dir)
    candidates = (
        ("issue-review-result.json", "issue-review-workflow-result"),
        (
            "issue-review.two-stage-result.json",
            "issue-review-two-stage-workflow-result",
        ),
        (
            "issue-review.single-agent-result.json",
            "issue-review-single-agent-workflow-result",
        ),
        (
            "repository-review-result.json",
            "repository-review-workflow-result",
        ),
    )
    for filename, workflow_kind in candidates:
        paths = (run_dir / filename, artifact_root / filename)
        path = next((item for item in paths if item.exists()), None)
        if path is not None:
            return workflow_kind, None
    return None, None


def _infer_retry_count_used(
    attempts: list[AttemptUsage],
    *,
    has_workflow_result: bool,
) -> int | None:
    retry_indexes: list[int] = []
    for attempt in attempts:
        label = attempt.attempt_label
        if not label.startswith("retry-"):
            continue
        try:
            retry_indexes.append(int(label.split("-", 1)[1]))
        except ValueError:
            continue
    if retry_indexes:
        return max(retry_indexes)
    if attempts or has_workflow_result:
        return 0
    return None


def _read_experiment_name(run_dir: Path) -> str | None:
    path = run_dir / "experiment-name.txt"
    if not path.exists():
        return None
    value = path.read_text(encoding="utf-8").strip()
    return value or None


def _model_id_from_metadata(metadata: dict[str, Any]) -> str | None:
    model_name = metadata.get("model_name") or metadata.get("model")
    provider = metadata.get("model_provider") or metadata.get("provider")
    if isinstance(model_name, str) and model_name.strip():
        if isinstance(provider, str) and provider.strip():
            return f"{provider.strip()}/{model_name.strip()}"
        return model_name.strip()
    return None


def _model_id_from_value(value: dict[str, Any]) -> str | None:
    direct_model = _model_id_from_metadata(value)
    if direct_model is not None:
        return direct_model
    metadata = value.get("response_metadata")
    if isinstance(metadata, dict):
        return _model_id_from_metadata(metadata)
    return None


def _usage_records_from_value(
    value: Any,
    inherited_model_id: str | None = None,
) -> list[tuple[dict[str, int], str | None]]:
    records: list[tuple[dict[str, int], str | None]] = []
    if isinstance(value, dict):
        model_id = _model_id_from_value(value) or inherited_model_id
        usage_metadata = value.get("usage_metadata")
        if isinstance(usage_metadata, dict):
            direct_usage = usage_from_langchain_metadata(usage_metadata)
            if direct_usage is not None:
                return [(direct_usage, model_id)]

        response_metadata = value.get("response_metadata")
        if isinstance(response_metadata, dict):
            provider_usage = response_metadata.get("token_usage")
            if isinstance(provider_usage, dict):
                direct_usage = usage_from_provider_metadata(provider_usage)
                if direct_usage is not None:
                    return [(direct_usage, model_id)]
            response_usage = response_metadata.get("usage")
            if isinstance(response_usage, dict):
                direct_usage = usage_from_langchain_metadata(response_usage)
                if direct_usage is not None:
                    return [(direct_usage, model_id)]

        direct_usage = usage_from_provider_metadata(
            value
        ) or usage_from_langchain_metadata(value)
        if direct_usage is not None:
            return [(direct_usage, model_id)]

        for nested in value.values():
            records.extend(_usage_records_from_value(nested, model_id))
    elif isinstance(value, list):
        for item in value:
            records.extend(_usage_records_from_value(item, inherited_model_id))
    return records


def _fallback_model_id(messages: list[dict[str, Any]]) -> str | None:
    """Recover a model id from transcript metadata when usage lacks one."""
    for message in messages:
        model_id = _model_id_from_value(message)
        if model_id is not None:
            return model_id
    return None


def _read_transcript_usage(path: Path) -> StageUsage:
    value = json.loads(path.read_text(encoding="utf-8"))
    messages = value if isinstance(value, list) else []
    records = _usage_records_from_value(messages)
    totals = {field: 0 for field in NUMERIC_FIELDS}
    for record, _model_id in records:
        for field in NUMERIC_FIELDS:
            totals[field] += int(record.get(field, 0) or 0)

    model_ids = sorted(
        {
            model_id.strip()
            for _record, model_id in records
            if isinstance(model_id, str) and model_id.strip()
        }
    )
    if len(model_ids) == 1:
        model_id = model_ids[0]
    elif len(model_ids) > 1:
        model_id = "mixed"
    else:
        model_id = _fallback_model_id(messages) or "unknown"

    stage, _attempt = _transcript_stage_attempt(path)
    return StageUsage(
        stage=stage,
        model_id=model_id,
        input_tokens=totals["input_tokens"],
        output_tokens=totals["output_tokens"],
        total_tokens=totals["total_tokens"],
        cache_read_tokens=totals["cache_read_tokens"],
        reasoning_tokens=totals["reasoning_tokens"],
        ai_message_count=len(records),
        ai_messages_with_usage_count=len(records),
    )


def _attempt_sort_key(label: str) -> tuple[int, int]:
    if label == "initial":
        return (0, 0)
    if label.startswith("retry-"):
        try:
            return (1, int(label.split("-", 1)[1]))
        except ValueError:
            return (1, 999999)
    return (2, 999999)


def _transcript_stage_attempt(path: Path) -> tuple[str, str]:
    if path.parent.name == "transcripts":
        return path.parent.parent.name, path.stem
    if path.name == "transcript.json":
        if (
            path.parent.parent.name == "batches"
            and path.parent.parent.parent.name in PASS_STAGE_DIRS
        ):
            return path.parent.parent.parent.name, path.parent.name
        if path.parent.parent.name in PASS_STAGE_DIRS:
            return path.parent.parent.name, path.parent.name
        return path.parent.name, "initial"
    return path.parent.name, path.stem


def _discover_transcripts(artifact_root: Path) -> list[Path]:
    transcripts: set[Path] = set()
    published_root = artifact_root / "transcripts"

    for candidate in artifact_root.rglob("*.json"):
        if published_root in candidate.parents:
            continue
        if (
            candidate.name == "transcript.json"
            or candidate.parent.name == "transcripts"
        ):
            transcripts.add(candidate)
    return sorted(transcripts)


def _aggregate_stage_usage(
    stage: str, model_id: str, attempts: list[AttemptUsage]
) -> StageUsage:
    payloads = [attempt.usage for attempt in attempts]
    return StageUsage(
        stage=stage,
        model_id=model_id,
        input_tokens=sum(item.input_tokens for item in payloads),
        output_tokens=sum(item.output_tokens for item in payloads),
        total_tokens=sum(item.total_tokens for item in payloads),
        cache_read_tokens=sum(item.cache_read_tokens for item in payloads),
        reasoning_tokens=sum(item.reasoning_tokens for item in payloads),
        ai_message_count=sum(item.ai_message_count for item in payloads),
        ai_messages_with_usage_count=sum(
            item.ai_messages_with_usage_count for item in payloads
        ),
    )


def _stage_sort_key(stage: StageUsage) -> tuple[int, str, str]:
    order = {
        "discovery": 10,
        "triage": 20,
        "triage-refiner": 30,
        "analysis": 40,
        "analyzer": 40,
        "cvss-v4-scoring": 50,
        "mitigation": 60,
        "mitigator": 60,
        "verification": 70,
        "verifier": 70,
        "delivery-planning": 80,
        "patch-synthesis": 90,
        "single-agent": 100,
    }
    return (order.get(stage.stage, 999), stage.stage, stage.model_id)


def _load_attempt_usages(artifact_root: Path) -> list[AttemptUsage]:
    attempts: list[AttemptUsage] = []
    for transcript_path in _discover_transcripts(artifact_root):
        stage_name, attempt_label = _transcript_stage_attempt(transcript_path)
        usage = _read_transcript_usage(transcript_path)
        attempts.append(
            AttemptUsage(
                stage=stage_name,
                attempt_label=attempt_label,
                usage=usage,
            )
        )
    attempts.sort(key=lambda item: (item.stage, _attempt_sort_key(item.attempt_label)))
    return attempts


def _load_stage_usages(attempts: list[AttemptUsage]) -> list[StageUsage]:
    grouped: dict[tuple[str, str], list[AttemptUsage]] = {}
    for attempt in attempts:
        grouped.setdefault((attempt.stage, attempt.usage.model_id), []).append(attempt)

    stages = [
        _aggregate_stage_usage(stage, model_id, items)
        for (stage, model_id), items in grouped.items()
    ]
    return sorted(stages, key=_stage_sort_key)


def load_run_usage(run_dir: Path) -> RunUsage:
    artifact_root = _artifact_root(run_dir)
    workflow_kind, retry_count_used = _detect_workflow_metadata(run_dir)
    attempts = _load_attempt_usages(artifact_root)
    stages = _load_stage_usages(attempts)

    return RunUsage(
        run_dir=str(run_dir),
        experiment=_read_experiment_name(run_dir),
        workflow_kind=workflow_kind,
        retry_count_used=(
            retry_count_used
            if isinstance(retry_count_used, int)
            else _infer_retry_count_used(
                attempts,
                has_workflow_result=workflow_kind is not None,
            )
        ),
        stages=stages,
        attempts=attempts,
    )
