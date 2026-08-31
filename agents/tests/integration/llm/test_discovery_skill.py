# Real-LLM repository discovery agent probe for progressive-disclosure skill usage.
#
# This test uses the actual repository discovery agent instead of the issue analyzer.
# It does not instruct the model to read /skills. The prompt only provides inline
# repository files; the normal SkillsMiddleware exposure must be enough for the model
# to load the relevant language/framework reference when framework semantics matter.
# This is intentionally a skill-usage probe, not a discovery-correctness test.

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.scan_stages.discovery.execution import (
    run_repository_discovery_agent,
)
from tests.integration.llm.probe_helpers import llm_probe
from tests.integration.llm.transcript_artifact_helpers import (
    read_file_paths_from_transcript,
)

PROBE = llm_probe(
    run_env="RUN_LLM_DISCOVERY_SKILL_INTEGRATION",
    description="real LLM discovery skill usage probe",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_discovery_reads_language_framework_skill_for_express_ordering(
    tmp_path: Path,
) -> None:
    artifacts = tmp_path / "artifacts"
    chunk = {
        "chunk_id": "discovery-chunk-0001",
        "entries": [
            {
                "path": "src/app.js",
                "language": "javascript",
                "size_bytes": 1,
            }
        ],
    }
    sources = {
        "src/app.js": "\n".join(
            [
                "const express = require('express');",
                "",
                "const app = express();",
                "",
                "function requireAuth(req, res, next) {",
                "  if (req.header('x-user') !== 'admin') {",
                "    res.status(401).json({ error: 'login required' });",
                "    return;",
                "  }",
                "  next();",
                "}",
                "",
                "app.get('/admin/export', (req, res) => {",
                "  res.json({ token: process.env.ADMIN_EXPORT_TOKEN, rows: [] });",
                "});",
                "",
                "app.use(requireAuth);",
                "",
                "app.get('/account', (req, res) => {",
                "  res.json({ user: req.header('x-user') });",
                "});",
                "",
            ]
        ),
    }

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        result = await run_repository_discovery_agent(
            chunk=chunk,
            sources=sources,
            discovery_artifacts_path=artifacts,
        )

    transcript_path = artifacts / "transcripts" / f"{chunk['chunk_id']}.jsonl"
    read_paths = read_file_paths_from_transcript(transcript_path)
    result_text = json.dumps(result, ensure_ascii=False).lower()

    print(
        json.dumps(
            {
                "readPaths": read_paths,
                "result": result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    assert "/skills/language-framework-security/SKILL.md" in read_paths
    assert (
        "/skills/language-framework-security/references/javascript-express.md"
        in read_paths
    )
    assert "admin/export" in result_text
    assert "middleware" in result_text
    assert "auth" in result_text
    assert result.get("candidates")
