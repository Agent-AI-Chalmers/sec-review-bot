# Real-LLM smoke for the repository analyzer with Docker + writable workspace +
# CodeGraph MCP. The target issue is intentionally cross-file so CodeGraph's
# symbol/caller navigation has a real job to do.

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.workflows.repository_case.analysis import analyze_repository_case
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe
from tests.integration.llm.transcript_artifact_helpers import tool_usage_from_transcript

_CODEGRAPH_DOCKER_IMAGE_ENV = "AGENT_CODEGRAPH_DOCKER_IMAGE"
_DEFAULT_CODEGRAPH_DOCKER_IMAGE = "sec-review-bot-workspace:codegraph"


def _codegraph_docker_image() -> str:
    return (
        os.environ.get(_CODEGRAPH_DOCKER_IMAGE_ENV) or _DEFAULT_CODEGRAPH_DOCKER_IMAGE
    )


def _docker_image_exists(image: str) -> bool:
    if not is_docker_runtime_available(default_docker_bin()):
        return False
    result = subprocess.run(
        [default_docker_bin(), "image", "inspect", image],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode == 0


PROBE = llm_probe(
    run_env="RUN_LLM_ANALYZER_CODEGRAPH_DOCKER_INTEGRATION",
    description="real LLM repository analyzer Docker + CodeGraph probe",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="CodeGraph Docker image",
            is_met=lambda: _docker_image_exists(_codegraph_docker_image()),
            instruction=(
                "build the CodeGraph Docker image with: docker build -f "
                "agents/docker/workspace-codegraph.Dockerfile -t "
                "sec-review-bot-workspace:codegraph agents"
            ),
        ),
    ),
)


@PROBE.skip_unless()
@pytest.mark.asyncio
async def test_repository_analyzer_codegraph_comparison_for_cross_file_ssti() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        root = Path(tempdir)
        source_workspace = root / "source-workspace"
        _write_ssti_workspace(source_workspace)

        filesystem_only = await _run_probe(
            root=root,
            source_workspace=source_workspace,
            label="filesystem-only",
            codegraph_enabled=False,
        )
        with_codegraph = await _run_probe(
            root=root,
            source_workspace=source_workspace,
            label="with-codegraph",
            codegraph_enabled=True,
        )

        assert not filesystem_only["toolUsage"]["usedCodeGraph"]

        result = with_codegraph["result"]
        assert result["verdict"] == "confirmed-vulnerability"
        assert with_codegraph["toolUsage"]["usedCodeGraph"]
        result_text = json.dumps(result, ensure_ascii=False).lower()
        assert "template" in result_text
        assert "jinja" in result_text
        assert "render_user_template" in result_text
        assert not (
            source_workspace / ".codegraph"
        ).exists(), "CodeGraph index must stay in the stage-owned workspace copy"
        print(
            json.dumps(
                {
                    "filesystemOnly": filesystem_only,
                    "withCodeGraph": with_codegraph,
                },
                ensure_ascii=False,
                indent=2,
            )
        )


async def _run_probe(
    *,
    root: Path,
    source_workspace: Path,
    label: str,
    codegraph_enabled: bool,
) -> dict[str, Any]:
    analyzer_artifacts = root / "artifacts" / label / "analyzer"
    snapshot_tar = root / "artifacts" / label / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=source_workspace,
        tar_path=snapshot_tar,
    )
    with _docker_environment(codegraph_enabled=codegraph_enabled):
        result = await analyze_repository_case(
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=None,
            incremental_window_path=None,
            analyzer_artifacts_path=analyzer_artifacts,
            scan_mode="full",
            review_input=(
                "Audit this repository for a server-side template injection "
                "risk in the preview feature. Trace the route handler through "
                "helper functions to the decisive sink. Return a "
                "repository-grounded analysis, not a generic Jinja2 warning."
            ),
        )
    result_text = json.dumps(result, ensure_ascii=False).lower()
    return {
        "verdict": result.get("verdict"),
        "mentionsJinja": "jinja" in result_text,
        "mentionsRenderUserTemplate": "render_user_template" in result_text,
        "toolUsage": tool_usage_from_transcript(
            analyzer_artifacts / "transcript.json",
            observations=(_codegraph_tool_observation,),
        ),
        "result": result,
    }


def _docker_environment(*, codegraph_enabled: bool):
    return patch.dict(
        os.environ,
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": _codegraph_docker_image(),
            "AGENT_MCP_ENABLED": "true" if codegraph_enabled else "false",
        },
        clear=False,
    )


def _write_ssti_workspace(workspace: Path) -> None:
    (workspace / "web").mkdir(parents=True)
    (workspace / "web" / "__init__.py").write_text("", encoding="utf-8")
    (workspace / "web" / "routes.py").write_text(
        "\n".join(
            [
                "from .views import render_preview",
                "",
                "",
                "def register_routes(app):",
                "    @app.post('/preview')",
                "    def preview(request):",
                "        payload = request.get_json(silent=True) or {}",
                "        template = payload.get('template', '')",
                "        return {'html': render_preview(template)}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / "web" / "views.py").write_text(
        "\n".join(
            [
                "from .template_engine import render_user_template",
                "",
                "",
                "def render_preview(template_source):",
                "    return render_user_template(template_source)",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / "web" / "template_engine.py").write_text(
        "\n".join(
            [
                "from jinja2 import Template",
                "",
                "",
                "def render_user_template(source):",
                "    # Product intentionally supports previewing stored snippets,",
                "    # but this function receives raw request JSON from /preview.",
                "    return Template(source).render()",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _codegraph_tool_observation(usage: dict[str, Any]) -> dict[str, Any]:
    names = usage["toolNames"]
    return {
        "codegraphToolCalls": sum(name.startswith("codegraph_") for name in names),
        "usedCodeGraph": any(name.startswith("codegraph_") for name in names),
    }
