import json
import os
from pathlib import Path
from uuid import uuid4

import pytest

from tests.workflows.issue.cases.loader import load_issue_cases
from tests.workflows.issue.cases.runner import assert_issue_case_oracle
from tests.workflows.issue.llm_helpers import (
    ISSUE_LLM_ENABLED,
    ISSUE_LLM_SKIP_REASON,
    analyze_issue_case,
    confirmed_findings,
    confirmed_narratives,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]


CASES = load_issue_cases()


def _repeat_count() -> int:
    raw_value = os.environ.get("NON_DATAFLOW_EVIDENCE_PROBE_REPEATS", "1")
    try:
        repeats = int(raw_value)
    except ValueError as exc:
        raise ValueError(
            "NON_DATAFLOW_EVIDENCE_PROBE_REPEATS must be an integer"
        ) from exc
    if not 1 <= repeats <= 10:
        raise ValueError("NON_DATAFLOW_EVIDENCE_PROBE_REPEATS must be between 1 and 10")
    return repeats


RUNS = tuple(
    pytest.param(case, repeat, id=f"{case.id}-run-{repeat}")
    for case in CASES
    for repeat in range(1, _repeat_count() + 1)
)


def _record_result(*, case, repeat: int, result: dict) -> Path:
    output_root = Path(
        os.environ.get(
            "NON_DATAFLOW_EVIDENCE_OUTPUT_DIR",
            ".agent-artifacts/non-dataflow-evidence",
        )
    )
    case_root = output_root / case.id
    case_root.mkdir(parents=True, exist_ok=True)
    artifact = case_root / f"run-{repeat}-{uuid4().hex}.json"
    findings = confirmed_findings(result)
    artifact.write_text(
        json.dumps(
            {
                "case_id": case.id,
                "repeat": repeat,
                "oracle": case.oracle.model_dump(mode="json"),
                "analysis": result,
                "evidence_shape": [
                    {
                        "title": narrative.get("title"),
                        "flow_review": narrative.get("flow_review"),
                        "scope_review": narrative.get("scope_review"),
                        "support_review": narrative.get("support_review"),
                    }
                    for narrative in findings
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"non-dataflow evidence artifact: {artifact}")
    return artifact


@pytest.mark.skipif(not ISSUE_LLM_ENABLED, reason=ISSUE_LLM_SKIP_REASON)
@pytest.mark.asyncio
@pytest.mark.parametrize(("case", "repeat"), RUNS)
async def test_issue_analyzer_non_dataflow_evidence_shape(case, repeat: int) -> None:
    """Expose whether flow fields preserve the real mechanism on non-dataflow cases."""
    result = await analyze_issue_case(
        workspace_files=case.load_workspace_files(),
        issue=case.issue.model_dump(),
    )
    _record_result(case=case, repeat=repeat, result=result)

    assert_issue_case_oracle(case, result)

    for narrative in confirmed_narratives(result):
        flow_review = narrative.get("flow_review") or {}
        assert flow_review.get("source_facts"), narrative
        assert flow_review.get("sink_facts"), narrative
