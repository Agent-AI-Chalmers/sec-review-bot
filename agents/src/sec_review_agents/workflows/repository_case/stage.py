from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.utils.paths import required_path
from sec_review_agents.workflows.repository_case.analysis import (
    analyze_repository_case,
)
from sec_review_agents.workflows.repository_case.cvss import (
    score_repository_cvss_v4,
)
from sec_review_agents.workflows.repository_case.mitigation import (
    mitigate_repository_case,
)
from sec_review_agents.workflows.repository_case.verification import (
    verify_repository_case,
)
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_NO_TEST_CHANGES,
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
)

MITIGATION_NO_TARGET_REASON = (
    "No confirmed, reparable mitigation target was available from the repository "
    "analyzer output."
)


def _blocked_case_disposition(reason: str) -> dict[str, Any]:
    return {
        "disposition": "blocked",
        "reason": reason,
    }


def should_run_repository_mitigation(
    analysis_result: Mapping[str, Any] | None,
) -> bool:
    narratives = (analysis_result or {}).get("narratives")
    if not isinstance(narratives, list):
        return False
    return any(
        isinstance(narrative, dict)
        and narrative.get("verdict") in {"confirmed-vulnerability", "confirmed-defect"}
        for narrative in narratives
    )


def derive_case_disposition(
    analyzer_result: Mapping[str, Any],
    mitigator_result: Mapping[str, Any],
    verifier_result: Mapping[str, Any],
) -> dict[str, Any]:
    verdict = analyzer_result.get("verdict")
    changed_files = mitigator_result.get("changed_files")
    if not (isinstance(changed_files, list) and changed_files):
        return _blocked_case_disposition("The case did not produce an applied patch.")

    if verifier_result.get("patch_coverage") != "full":
        return _blocked_case_disposition(
            "The verifier did not fully approve the patch for delivery execution."
        )

    if verdict not in {"confirmed-defect", "confirmed-vulnerability", "plausible-risk"}:
        return _blocked_case_disposition(
            "The analyzer did not confirm the case strongly enough for delivery execution."
        )

    return {
        "disposition": "keep",
        "reason": "Case passed analyzer, mitigator, and verifier delivery gates.",
    }


def _optional_case_path(
    case_execution_input: Mapping[str, Any],
    key: str,
) -> Path | None:
    value = case_execution_input.get(key)
    if isinstance(value, str) and value.strip():
        return Path(value)
    return None


def _case_path(case_execution_input: Mapping[str, Any], key: str) -> Path:
    return required_path(case_execution_input.get(key), label=key)


def _case_repair_mode(case_execution_input: Mapping[str, Any]) -> RepairMode:
    value = case_execution_input.get("repair_mode")
    if value == REPAIR_MODE_TEST_CHANGES_ALLOWED:
        return REPAIR_MODE_TEST_CHANGES_ALLOWED
    if value == REPAIR_MODE_NO_TEST_CHANGES:
        return REPAIR_MODE_NO_TEST_CHANGES
    raise ValueError("Repository case execution input is missing valid repair_mode.")


def repository_case_stage_artifact_paths(
    *, cases_artifacts_path: Path, case_id: str
) -> dict[str, str]:
    case_root = cases_artifacts_path / case_id
    return {
        "analyzer": str(case_root / "analyzer"),
        "cvss": str(case_root / "cvss"),
        "mitigator": str(case_root / "mitigator"),
        "verifier": str(case_root / "verifier"),
    }


async def analyze_repository_case_stage(
    case_execution_input: Mapping[str, Any],
    *,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    runtime_context: RunnerRuntimeContext | None,
) -> dict[str, Any]:
    case_id = str(case_execution_input["case_id"])
    scan_mode = case_execution_input["scan_mode"]
    review_input = case_execution_input["review_input"]
    workspace_snapshot_tar_path = _case_path(
        case_execution_input, "workspace_snapshot_tar_path"
    )
    history_path = _optional_case_path(case_execution_input, "history_path")
    incremental_window_path = _optional_case_path(
        case_execution_input,
        "incremental_window_path",
    )
    started_at = log_stage_started(
        stage="analyzer",
        case_id=case_id,
    )
    try:
        result = await analyze_repository_case(
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            analyzer_artifacts_path=analyzer_artifacts_path,
            published_transcript_path=published_transcript_path,
            scan_mode=scan_mode,
            review_input=review_input,
            runtime_context=runtime_context,
        )

        log_stage_completed(
            stage="analyzer",
            started_at=started_at,
            case_id=case_id,
            verdict=result.get("verdict"),
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage="analyzer",
            started_at=started_at,
            error=error,
            case_id=case_id,
        )
        raise


async def score_repository_case_cvss_stage(
    case_execution_input: Mapping[str, Any],
    analyzer_result: Mapping[str, Any],
    *,
    cvss_artifacts_path: Path,
) -> dict[str, Any]:
    case_id = case_execution_input.get("case_id")
    workspace_snapshot_tar_path = _case_path(
        case_execution_input, "workspace_snapshot_tar_path"
    )
    started_at = log_stage_started(
        stage="cvss-v4-scoring",
        case_id=case_id,
    )
    try:
        result = await score_repository_cvss_v4(
            cvss_artifacts_path=cvss_artifacts_path,
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            review_input=case_execution_input["review_input"],
            analysis_result=analyzer_result,
        )

        log_stage_completed(
            stage="cvss-v4-scoring",
            started_at=started_at,
            case_id=case_id,
            outcome=result.get("outcome"),
            base_score=result.get("base_score"),
            severity=result.get("severity"),
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage="cvss-v4-scoring",
            started_at=started_at,
            error=error,
            case_id=case_id,
        )
        raise


async def run_repository_case_mitigation_stage(
    case_execution_input: Mapping[str, Any],
    analyzer_result: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None,
    runtime_context: RunnerRuntimeContext | None,
    *,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None = None,
) -> dict[str, Any]:
    case_id = str(case_execution_input["case_id"])
    started_at = log_stage_started(
        stage="mitigator",
        case_id=case_id,
    )
    try:
        result = await mitigate_repository_case(
            workspace_snapshot_tar_path=_case_path(
                case_execution_input,
                "workspace_snapshot_tar_path",
            ),
            history_path=_optional_case_path(case_execution_input, "history_path"),
            incremental_window_path=_optional_case_path(
                case_execution_input,
                "incremental_window_path",
            ),
            mitigator_artifacts_path=mitigator_artifacts_path,
            published_transcript_path=published_transcript_path,
            scan_mode=case_execution_input["scan_mode"],
            review_input=case_execution_input["review_input"],
            analysis_result=analyzer_result,
            retry_context=retry_context,
            repair_mode=_case_repair_mode(case_execution_input),
            runtime_context=runtime_context,
        )

        log_stage_completed(
            stage="mitigator",
            started_at=started_at,
            case_id=case_id,
            changed_file_count=len(result.get("changed_files") or []),
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage="mitigator",
            started_at=started_at,
            error=error,
            case_id=case_id,
        )
        raise


async def run_repository_case_verification_stage(
    case_execution_input: Mapping[str, Any],
    analyzer_result: Mapping[str, Any],
    mitigator_result: Mapping[str, Any] | None,
    retry_context: Mapping[str, Any] | None,
    runtime_context: RunnerRuntimeContext | None,
    *,
    verifier_artifacts_path: Path,
    published_transcript_path: Path | None = None,
) -> dict[str, Any]:
    case_id = str(case_execution_input["case_id"])
    started_at = log_stage_started(
        stage="verifier",
        case_id=case_id,
    )
    try:
        result = await verify_repository_case(
            verifier_artifacts_path=verifier_artifacts_path,
            published_transcript_path=published_transcript_path,
            workspace_snapshot_tar_path=_case_path(
                case_execution_input,
                "workspace_snapshot_tar_path",
            ),
            history_path=_optional_case_path(case_execution_input, "history_path"),
            incremental_window_path=_optional_case_path(
                case_execution_input,
                "incremental_window_path",
            ),
            scan_mode=case_execution_input["scan_mode"],
            review_input=case_execution_input["review_input"],
            analysis_result=analyzer_result,
            mitigation_result=mitigator_result,
            retry_context=retry_context,
            runtime_context=runtime_context,
        )

        log_stage_completed(
            stage="verifier",
            started_at=started_at,
            case_id=case_id,
            patch_coverage=result.get("patch_coverage"),
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage="verifier",
            started_at=started_at,
            error=error,
            case_id=case_id,
        )
        raise
