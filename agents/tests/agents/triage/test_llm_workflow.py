# Real-LLM repository triage workflow smoke test.
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

from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
)
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
from sec_review_agents.scan_stages.triage.agent_passes import (
    run_repository_triage_agent,
)
from tests.llm_probe import llm_probe
from tests.runtime.trajectory_artifact_helpers import (
    read_file_paths_from_trajectory,
)

pytestmark = [pytest.mark.integration, pytest.mark.llm]

PROBE = llm_probe(
    run_env="RUN_LLM_TRIAGE_WORKFLOW_INTEGRATION",
    description="real LLM triage workflow smoke test",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_triage_workflow_handles_scanner_noise_and_uses_guidance() -> None:
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

    read_paths = read_file_paths_from_trajectory(triage_root / "trajectory.jsonl")

    print(
        json.dumps(
            {
                "artifact_root": str(triage_root),
                "readPaths": read_paths,
                "readScannerFindingSkill": (
                    "/skills/scanner-finding-triage/SKILL.md" in read_paths
                ),
                "result": result.model_dump(mode="json"),
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
        for case in result.cases
        for candidate_id in case.member_candidate_ids
    }
    suppressed_candidate_ids = {
        candidate.candidate_id for candidate in result.suppressed_candidates
    }

    assert "internal-export-unknown-guard" in kept_candidate_ids
    assert "runtime-yaml-import" in kept_candidate_ids
    assert "sca-minimist-lockfile-only" in suppressed_candidate_ids
    assert "eval-test-fixture-only" in suppressed_candidate_ids
    assert "copy-dot-with-dockerignore" in suppressed_candidate_ids
    assert "signed-cache-deserialize" in suppressed_candidate_ids


def _artifact_root() -> Path:
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return (
        Path(".agent-artifacts") / "triage-workflow-llm" / f"{run_id}-{uuid4().hex[:8]}"
    )


def _scanner_style_candidates() -> list[DiscoveryCandidateResult]:
    return [
        DiscoveryCandidateResult(
            candidate_id="internal-export-unknown-guard",
            candidate=DiscoveryCandidate(
                category="Access control",
                description="An authenticated tenant user supplies object_id to the internal "
                "export endpoint, which returns load_export(object_id). The payload "
                "does not establish whether middleware enforces object ownership. "
                "The internal label alone does not establish tenant isolation; "
                "the ownership guard needs repository analysis.",
                locations=[
                    DiscoveryLocation(
                        file="src/internal/export.py", line=20, label="Export lookup"
                    )
                ],
                evidence=["return load_export(request.json['object_id'])"],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="sca-minimist-lockfile-only",
            candidate=DiscoveryCandidate(
                category="Dependency vulnerability",
                description="A dependency scanner reports a high-severity prototype "
                "pollution CVE because minimist 0.0.8 appears in package-lock. "
                "The candidate payload contains no repository import, call site, "
                "CLI entry point, or parser path that uses minimist.",
                locations=[
                    DiscoveryLocation(
                        file="package-lock.json",
                        line=412,
                        label="minimist 0.0.8 appears in lockfile",
                    )
                ],
                evidence=[
                    '"node_modules/minimist": {"version": "0.0.8"}',
                    "No locations outside package-lock.json were reported.",
                ],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="eval-test-fixture-only",
            candidate=DiscoveryCandidate(
                category="Code execution",
                description="A static scanner reports eval() usage. The only anchor is a "
                "test fixture used to assert that the linter catches eval in "
                "sample code; no runtime route, exported API, or application "
                "handler is shown.",
                locations=[
                    DiscoveryLocation(
                        file="tests/fixtures/legacy-eval.js",
                        line=18,
                        label="eval() appears in a test fixture",
                    )
                ],
                evidence=[
                    "tests/fixtures/legacy-eval.js",
                    "eval(sample)",
                    "Referenced from tests/lint-rules.test.js only.",
                ],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="copy-dot-with-dockerignore",
            candidate=DiscoveryCandidate(
                category="Container image exposure",
                description="A scanner reports that COPY . . may copy secrets into image "
                "layers. The same candidate payload shows .dockerignore entries "
                "for .env, .git, *.pem, id_rsa, and production-secrets.txt, and "
                "does not identify any actual sensitive file in the build context.",
                locations=[
                    DiscoveryLocation(
                        file="Dockerfile", line=8, label="Broad COPY . . instruction"
                    ),
                    DiscoveryLocation(
                        file=".dockerignore",
                        line=1,
                        label="Build context excludes common secret files",
                    ),
                ],
                evidence=[
                    "Dockerfile: COPY . .",
                    ".dockerignore: .env",
                    ".dockerignore: .git",
                    ".dockerignore: *.pem",
                    ".dockerignore: production-secrets.txt",
                ],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="signed-cache-deserialize",
            candidate=DiscoveryCandidate(
                category="Deserialization",
                description="A scanner reports a deserialization sink. The candidate evidence "
                "shows the blob is loaded from an internal Redis key and "
                "verify_hmac(blob, SESSION_CACHE_KEY) must pass before "
                "deserialize(blob) is called. No attacker-controlled request "
                "source is shown.",
                locations=[
                    DiscoveryLocation(
                        file="src/cache/session_store.py",
                        line=44,
                        label="deserialize() called after signature verification",
                    ),
                ],
                evidence=[
                    "blob = redis.get(cache_key)",
                    "if not verify_hmac(blob, SESSION_CACHE_KEY): return None",
                    "return deserialize(blob)",
                ],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="runtime-yaml-import",
            candidate=DiscoveryCandidate(
                category="Unsafe deserialization",
                description="The /admin/import-yaml endpoint reads an uploaded request body "
                "and passes it to yaml.load(..., Loader=yaml.Loader). This is a "
                "runtime route with attacker-controlled file content reaching an "
                "unsafe parser sink.",
                locations=[
                    DiscoveryLocation(
                        file="src/routes/imports.py",
                        line=27,
                        label="Uploaded file body read from request",
                    ),
                    DiscoveryLocation(
                        file="src/routes/imports.py",
                        line=31,
                        label="yaml.load called with unsafe Loader",
                    ),
                ],
                evidence=[
                    "body = request.files['config'].read()",
                    "parsed = yaml.load(body, Loader=yaml.Loader)",
                ],
            ),
            grounding_status="grounded",
        ),
    ]


def _availability_candidates() -> list[DiscoveryCandidateResult]:
    return [
        # Availability leads: discovery reports them, triage keeps only those an
        # outside attacker can drive. The terse wording mirrors real discovery
        # output, which states code facts without an impact argument.
        DiscoveryCandidateResult(
            candidate_id="public-regex-backtracking",
            candidate=DiscoveryCandidate(
                category="Resource abuse / regex",
                description="signup() matches request.form['email'] against "
                "re.compile(r'^([a-zA-Z0-9]+)*@example\\.com$'). The pattern has a "
                "nested quantifier and the input length is not checked.",
                locations=[
                    DiscoveryLocation(
                        file="app/routes/signup.py", line=18, label="Email regex"
                    )
                ],
                evidence=["EMAIL_RE.match(request.form['email'])"],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="operator-sandbox-no-timeout",
            candidate=DiscoveryCandidate(
                category="Resource abuse / unbounded execution",
                description="command_timeout_ms defaults to None when neither the "
                "constructor argument nor AGENT_BWRAP_COMMAND_TIMEOUT_MS is set, so "
                "sandboxed agent commands run with no timeout and can consume host "
                "resources. The commands are issued by the operator's own review "
                "agent inside its sandbox; no external request reaches this path.",
                locations=[
                    DiscoveryLocation(
                        file="agents/filesystem/bwrap_backend.py",
                        line=88,
                        label="No default command timeout",
                    )
                ],
                evidence=["effective_timeout = self.command_timeout_ms"],
            ),
            grounding_status="grounded",
        ),
        DiscoveryCandidateResult(
            candidate_id="admin-reindex-no-rate-limit",
            candidate=DiscoveryCandidate(
                category="Resource abuse / missing rate limiting",
                description="POST /admin/reindex triggers a full search reindex and "
                "has no rate limit. The route is wrapped by @require_role('admin'), "
                "so only administrators can call it.",
                locations=[
                    DiscoveryLocation(
                        file="app/routes/admin.py", line=52, label="Reindex route"
                    )
                ],
                evidence=["@require_role('admin')", "search.rebuild_all()"],
            ),
            grounding_status="grounded",
        ),
    ]


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_triage_keeps_attacker_driven_availability_leads_only() -> None:
    """Discovery reports availability leads; triage keeps only attacker-driven ones.

    The suppress rule for availability issues without a trust boundary must not
    drop a public unauthenticated ReDoS, while still dropping a lead only the
    operator's own agent can trigger. The admin-only lead stays in the input as a
    distractor but is not asserted: whether an administrator-triggered expensive
    job is worth keeping is a judgment call, and the model kept it in 1 of 3 runs.
    Kept separate from the scanner noise test so neither input set changes the
    other's skill-reading behavior.
    """
    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        result = await run_repository_triage_agent(
            triage_root=_artifact_root(),
            triage_candidates=_availability_candidates(),
            max_passes=1,
            triage_mode="single",
        )

    kept = {cid for case in result.cases for cid in case.member_candidate_ids}
    suppressed = {item.candidate_id for item in result.suppressed_candidates}
    assert "public-regex-backtracking" in kept
    assert "operator-sandbox-no-timeout" in suppressed
