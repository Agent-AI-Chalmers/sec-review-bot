# Real-LLM repository triage agent smoke test with progressive-disclosure skills exposed.
#
# The candidate payloads are adapted from historical `.agent-workspace` triage
# runs, then made intentionally scanner-shaped: dependency presence without
# usage, dangerous APIs in tests, broad COPY with .dockerignore context, and one
# concrete runtime source-to-sink path. The test does not instruct the model to
# read /skills; the normal SkillsMiddleware exposure should be enough for the
# model to load the scanner-finding triage reference when it needs reachability
# and context guidance.

import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from sec_review_agents.scan_stages.triage.agent_passes import (
    run_repository_triage_agent,
)
from tests.integration.llm.probe_helpers import llm_probe
from tests.integration.llm.transcript_artifact_helpers import (
    read_file_paths_from_transcript,
)

PROBE = llm_probe(
    run_env="RUN_LLM_TRIAGE_SKILL_INTEGRATION",
    description="real LLM triage skill smoke test",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_triage_reads_scanner_finding_skill_for_reachability_noise() -> None:
    triage_root = _artifact_root()

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        result = await run_repository_triage_agent(
            triage_root=triage_root,
            triage_candidates=_scanner_style_candidates(),
            max_passes=1,
            triage_mode="single",
        )

    read_paths = read_file_paths_from_transcript(triage_root / "transcript.json")

    print(
        json.dumps(
            {
                "artifact_root": str(triage_root),
                "readPaths": read_paths,
                "readScannerFindingSkill": (
                    "/skills/scanner-finding-triage/SKILL.md" in read_paths
                ),
                "result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    assert "/skills/scanner-finding-triage/SKILL.md" in read_paths
    assert any(
        path.startswith("/skills/scanner-finding-triage/references/")
        for path in read_paths
    ), read_paths
    kept_candidate_ids = {
        candidate_id
        for case in result.get("cases") or []
        for candidate_id in case.get("member_candidate_ids") or []
    }
    suppressed_candidate_ids = {
        candidate.get("candidate_id")
        for candidate in result.get("suppressed_candidates") or []
    }

    assert "runtime-yaml-import" in kept_candidate_ids
    assert "sca-minimist-lockfile-only" in suppressed_candidate_ids
    assert "eval-test-fixture-only" in suppressed_candidate_ids
    assert "copy-dot-with-dockerignore" in suppressed_candidate_ids
    assert "signed-cache-deserialize" in suppressed_candidate_ids


def _artifact_root() -> Path:
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path(".agent-artifacts") / "triage-skill-llm" / f"{run_id}-{uuid4().hex[:8]}"


def _scanner_style_candidates() -> list[dict]:
    return [
        {
            "candidate_id": "sca-minimist-lockfile-only",
            "title": "Scanner flags minimist CVE from package-lock entry",
            "category": "Dependency vulnerability",
            "paths": ["package-lock.json"],
            "locations": [
                {
                    "file": "package-lock.json",
                    "line": 412,
                    "label": "minimist 0.0.8 appears in lockfile",
                }
            ],
            "confidence": "high",
            "description": (
                "A dependency scanner reports a high-severity prototype "
                "pollution CVE because minimist 0.0.8 appears in package-lock. "
                "The candidate payload contains no repository import, call site, "
                "CLI entry point, or parser path that uses minimist."
            ),
            "evidence": [
                '"node_modules/minimist": {"version": "0.0.8"}',
                "No locations outside package-lock.json were reported.",
            ],
            "grounding_status": "grounded",
        },
        {
            "candidate_id": "eval-test-fixture-only",
            "title": "Scanner flags eval() in test fixture",
            "category": "Code execution",
            "paths": ["tests/fixtures/legacy-eval.js"],
            "locations": [
                {
                    "file": "tests/fixtures/legacy-eval.js",
                    "line": 18,
                    "label": "eval() appears in a test fixture",
                }
            ],
            "confidence": "medium",
            "description": (
                "A static scanner reports eval() usage. The only anchor is a "
                "test fixture used to assert that the linter catches eval in "
                "sample code; no runtime route, exported API, or application "
                "handler is shown."
            ),
            "evidence": [
                "tests/fixtures/legacy-eval.js",
                "eval(sample)",
                "Referenced from tests/lint-rules.test.js only.",
            ],
            "grounding_status": "grounded",
        },
        {
            "candidate_id": "copy-dot-with-dockerignore",
            "title": "Scanner flags broad COPY . . as possible secret leakage",
            "category": "Container image exposure",
            "paths": ["Dockerfile", ".dockerignore"],
            "locations": [
                {
                    "file": "Dockerfile",
                    "line": 8,
                    "label": "Broad COPY . . instruction",
                },
                {
                    "file": ".dockerignore",
                    "line": 1,
                    "label": "Build context excludes common secret files",
                },
            ],
            "confidence": "medium",
            "description": (
                "A scanner reports that COPY . . may copy secrets into image "
                "layers. The same candidate payload shows .dockerignore entries "
                "for .env, .git, *.pem, id_rsa, and production-secrets.txt, and "
                "does not identify any actual sensitive file in the build context."
            ),
            "evidence": [
                "Dockerfile: COPY . .",
                ".dockerignore: .env",
                ".dockerignore: .git",
                ".dockerignore: *.pem",
                ".dockerignore: production-secrets.txt",
            ],
            "grounding_status": "grounded",
        },
        {
            "candidate_id": "signed-cache-deserialize",
            "title": "Scanner flags deserialize() on cached blob",
            "category": "Deserialization",
            "paths": ["src/cache/session_store.py"],
            "locations": [
                {
                    "file": "src/cache/session_store.py",
                    "line": 44,
                    "label": "deserialize() called after signature verification",
                },
            ],
            "confidence": "medium",
            "description": (
                "A scanner reports a deserialization sink. The candidate evidence "
                "shows the blob is loaded from an internal Redis key and "
                "verify_hmac(blob, SESSION_CACHE_KEY) must pass before "
                "deserialize(blob) is called. No attacker-controlled request "
                "source is shown."
            ),
            "evidence": [
                "blob = redis.get(cache_key)",
                "if not verify_hmac(blob, SESSION_CACHE_KEY): return None",
                "return deserialize(blob)",
            ],
            "grounding_status": "grounded",
        },
        {
            "candidate_id": "runtime-yaml-import",
            "title": "Runtime YAML import endpoint parses uploaded user content unsafely",
            "category": "Unsafe deserialization",
            "paths": ["src/routes/imports.py"],
            "locations": [
                {
                    "file": "src/routes/imports.py",
                    "line": 27,
                    "label": "Uploaded file body read from request",
                },
                {
                    "file": "src/routes/imports.py",
                    "line": 31,
                    "label": "yaml.load called with unsafe Loader",
                },
            ],
            "confidence": "high",
            "description": (
                "The /admin/import-yaml endpoint reads an uploaded request body "
                "and passes it to yaml.load(..., Loader=yaml.Loader). This is a "
                "runtime route with attacker-controlled file content reaching an "
                "unsafe parser sink."
            ),
            "evidence": [
                "body = request.files['config'].read()",
                "parsed = yaml.load(body, Loader=yaml.Loader)",
            ],
            "grounding_status": "grounded",
        },
    ]
