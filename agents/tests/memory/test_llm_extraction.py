import json
import os
import shutil
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch
from uuid import uuid4

import pytest
from pydantic import BaseModel, ConfigDict

from sec_review_agents.memory.extractor import extract_memory_observations_from_paths
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
    memory_observations_dir,
)
from sec_review_agents.runtime.transcripts import serialize_agent_message
from tests.llm_probe import llm_probe, llm_test_deployment

pytestmark = [pytest.mark.integration, pytest.mark.llm]

EXTRACTION_PROBE = llm_probe(
    run_env="RUN_LLM_MEMORY_EXTRACTION_INTEGRATION",
    description="real LLM memory extraction probe",
)
FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "extractor-safety"
CURRENT_WRITER_FIXTURE_CASES = {
    "compaction-summary-conflict",
    "feedback-loop-correction",
}


class ExtractorSafetyCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    expect_observation: bool
    allow_skip: bool = False
    required_terms: list[str]
    required_any_terms: list[str]
    forbidden_terms: list[str]
    expect_memory_unchanged: bool


class TranscriptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["system", "human", "ai", "tool"]
    id: str | None
    name: str | None
    content: str | list[dict[str, Any]]
    additional_kwargs: dict[str, Any]
    response_metadata: dict[str, Any]
    tool_calls: list[dict[str, Any]]
    invalid_tool_calls: list[dict[str, Any]]
    tool_call_chunks: list[dict[str, Any]]
    usage_metadata: dict[str, Any] | None
    tool_call_id: str | None = None
    status: Literal["success", "error"] | None = None
    artifact: Any | None = None


class TranscriptEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int
    event: Literal["message"]
    message: TranscriptMessage


def _load_cases() -> tuple[tuple[ExtractorSafetyCase, Path], ...]:
    cases = []
    for case_path in sorted(FIXTURES_ROOT.glob("*/case.json")):
        case = ExtractorSafetyCase.model_validate_json(
            case_path.read_text(encoding="utf-8")
        )
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        transcript_dir = case_path.parent / "transcripts"
        if not list(transcript_dir.glob("*.jsonl")):
            raise AssertionError(f"no transcripts found for extractor case {case.id}")
        cases.append((case, transcript_dir))
    if not cases:
        raise AssertionError(f"no extractor safety cases found under {FIXTURES_ROOT}")
    return tuple(cases)


def _selected_system_prompt() -> str:
    variant = os.getenv("MEMORY_EXTRACTOR_PROMPT_VARIANT", "current")
    if variant == "current":
        from sec_review_agents.agents.memory_extractor.prompts import (
            MEMORY_EXTRACTOR_SYSTEM_PROMPT,
        )

        return MEMORY_EXTRACTOR_SYSTEM_PROMPT
    if variant in {"baseline", "candidate"}:
        return (FIXTURES_ROOT / f"{variant}-prompt.md").read_text(encoding="utf-8")
    raise AssertionError(
        "MEMORY_EXTRACTOR_PROMPT_VARIANT must be baseline, candidate, or current"
    )


def test_extractor_safety_fixtures_are_valid() -> None:
    cases = _load_cases()
    assert {case.id for case, _ in cases} == {
        "compaction-summary-conflict",
        "compromised-upstream-agent",
        "feedback-loop-correction",
        "privacy-entangled",
        "private-identifier-disguised-as-api",
        "prompt-injection",
        "tool-output-injection",
    }
    for case, transcript_dir in cases:
        for transcript in transcript_dir.glob("*.jsonl"):
            raw_events = [
                json.loads(line)
                for line in transcript.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            events = [TranscriptEvent.model_validate(event) for event in raw_events]
            assert [event.seq for event in events] == list(range(1, len(events) + 1))
            messages = [event.message for event in events]
            assert messages, f"empty transcript fixture: {transcript}"
            assert messages[0].type == "system"
            if case.id in CURRENT_WRITER_FIXTURE_CASES:
                tool_call_ids = {
                    call["id"]
                    for event in raw_events
                    for call in event["message"].get("tool_calls", [])
                }
                for event in raw_events:
                    message = event["message"]
                    assert message == serialize_agent_message(
                        message,
                        message_id=message["id"],
                    )
                    if message["type"] == "tool":
                        assert message["tool_call_id"] in tool_call_ids
        if case.expect_observation:
            assert case.required_terms
        else:
            assert not case.required_terms
            assert not case.required_any_terms


@pytest.mark.skipif(
    not EXTRACTION_PROBE.enabled(),
    reason=EXTRACTION_PROBE.skip_reason(),
)
@pytest.mark.parametrize(
    ("case", "transcript_dir"),
    _load_cases(),
    ids=[case.id for case, _ in _load_cases()],
)
@pytest.mark.asyncio
async def test_llm_extractor_safety_case(
    case: ExtractorSafetyCase,
    transcript_dir: Path,
) -> None:
    variant = os.getenv("MEMORY_EXTRACTOR_PROMPT_VARIANT", "current")
    root = (
        Path(".agent-artifacts")
        / "memory-probes"
        / f"{variant}-{case.id}-{uuid4().hex[:8]}"
    )
    artifacts = root / "artifacts"
    shutil.copytree(transcript_dir, artifacts / "transcripts")
    memory_root = initialize_memory_store(root / "memory")
    runtime_memory = memory_content_dir(memory_root) / "MEMORY.md"
    initial_memory = runtime_memory.read_text(encoding="utf-8")
    system_prompt = _selected_system_prompt()

    with (
        patch(
            "sec_review_agents.agents.memory_extractor.agent."
            "MEMORY_EXTRACTOR_SYSTEM_PROMPT",
            system_prompt,
        ),
        patch(
            "sec_review_agents.memory.extractor.MEMORY_EXTRACTOR_SYSTEM_PROMPT",
            system_prompt,
        ),
    ):
        result = await extract_memory_observations_from_paths(
            [artifacts],
            memory_store_dir=memory_root,
            deployment=llm_test_deployment(),
            job_id=f"llm-memory-{variant}-{case.id}",
            source_workflow="llm-memory-extractor-safety-probe",
            run_id=f"{variant}-{case.id}",
        )

    observation_files = list(memory_observations_dir(memory_root).glob("*.md"))
    output = result.summary
    if result.observation_path is not None:
        output += "\n" + result.observation_path.read_text(encoding="utf-8")
    lowered = output.lower()

    if not case.allow_skip:
        assert (not result.skipped) is case.expect_observation
    if case.expect_observation and not result.skipped:
        assert result.observation_path is not None
        assert observation_files == [result.observation_path]
    elif not case.expect_observation:
        assert result.observation_path is None
        assert not observation_files
    if not result.skipped:
        for term in case.required_terms:
            assert term.lower() in lowered
        if case.required_any_terms:
            assert any(term.lower() in lowered for term in case.required_any_terms)
    for term in case.forbidden_terms:
        assert term.lower() not in lowered
    if case.expect_memory_unchanged:
        assert runtime_memory.read_text(encoding="utf-8") == initial_memory
