# Real-LLM comparison on a public vulnerable checkout.
#
# This pins one CVE as a large-repo analyzer probe, checks out the vulnerable
# GitHub commit directly, and compares analyzer behavior with CodeGraph disabled
# vs enabled.

import json
import os
import secrets
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.utils.files import write_json
from sec_review_agents.utils.time import utc_now_iso
from sec_review_agents.workflows.issue.analysis import analyze_issue
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe
from tests.integration.llm.transcript_artifact_helpers import tool_usage_from_transcript

_WORKSPACE_IMAGE = "sec-review-bot-workspace:codegraph"
_RUN_ENV = "RUN_LLM_CODEGRAPH_REAL_CHECKOUT_INTEGRATION"
_OUTPUT_DIR_ENV = "CODEGRAPH_REAL_CHECKOUT_OUTPUT_DIR"
_DEFAULT_OUTPUT_ROOT = Path(".agent-artifacts/codegraph-real-checkout")


@dataclass(frozen=True)
class VulnerableCheckoutCase:
    cve_id: str
    repo_url: str
    repo_name: str
    vulnerable_commit: str
    title: str
    body: str
    vulnerable_files: tuple[str, ...]


_SNAPD_HOME_INTERFACE_CASE = VulnerableCheckoutCase(
    cve_id="CVE-2024-1724",
    repo_url="https://github.com/snapcore/snapd",
    repo_name="snapd",
    vulnerable_commit="9dace38c58b780fa946e61164babdc8deeb722e6",
    title=(
        "snapd AppArmor home interface allows writes to $HOME/bin through the home plug"
    ),
    body=(
        "In snapd, when AppArmor enforces sandbox permissions, the home "
        "interface failed to restrict writes to $HOME/bin. On Ubuntu this "
        "directory is commonly added to the user's PATH when it exists. A "
        "malicious snap with the home plug could place arbitrary scripts in "
        "$HOME/bin, and those scripts may later be executed by the user outside "
        "the expected snap sandbox. Audit the repository for the policy boundary "
        "that controls home interface access and determine whether the vulnerable "
        "checkout permits this path."
        "\n\nCWE:\n"
        "- CWE-732: Incorrect Permission Assignment for Critical Resource"
    ),
    vulnerable_files=("interfaces/builtin/home.go",),
)


def _docker_image_exists(image: str) -> bool:
    result = subprocess.run(
        ["docker", "image", "inspect", image],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode == 0


PROBE = llm_probe(
    run_env=_RUN_ENV,
    description="real LLM public-checkout CodeGraph comparison probe",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="CodeGraph workspace Docker image",
            is_met=lambda: _docker_image_exists(_WORKSPACE_IMAGE),
            instruction="build sec-review-bot-workspace:codegraph",
        ),
    ),
)


@PROBE.skip_unless()
@pytest.mark.asyncio
async def test_cve_2024_1724_snapd_analyzer_codegraph_comparison() -> None:
    case = _SNAPD_HOME_INTERFACE_CASE
    root = _create_run_root(case)
    workspace = root / "workspace"
    history = root / "history"
    artifacts = root / "artifacts"
    _checkout_vulnerable_commit(case, workspace)
    _write_issue_history(case, history)

    filesystem_only = await _run_analyzer_probe(
        case=case,
        workspace=workspace,
        history=history,
        artifacts=artifacts / "filesystem-only",
        codegraph_enabled=False,
    )
    with_codegraph = await _run_analyzer_probe(
        case=case,
        workspace=workspace,
        history=history,
        artifacts=artifacts / "with-codegraph",
        codegraph_enabled=True,
    )

    assert not filesystem_only["toolUsage"]["usedCodeGraph"]
    assert with_codegraph["toolUsage"]["usedCodeGraph"]
    assert not (
        workspace / ".codegraph"
    ).exists(), "CodeGraph index must stay in analyzer stage-owned workspace copy"
    assert (
        filesystem_only["mentionsKnownVulnerableFiles"]
        or with_codegraph["mentionsKnownVulnerableFiles"]
    )

    summary_path = root / "codegraph-real-checkout-summary.json"
    summary = {
        "run_root": str(root),
        "summaryPath": str(summary_path),
        "workspace": str(workspace),
        "history": str(history),
        "artifacts": str(artifacts),
        "cveId": case.cve_id,
        "repo": case.repo_url,
        "vulnerableCommit": case.vulnerable_commit,
        "filesystemOnly": filesystem_only,
        "withCodeGraph": with_codegraph,
    }
    # Keep expensive real-LLM probe evidence on disk for post-run inspection.
    write_json(summary_path, summary)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


def _create_run_root(case: VulnerableCheckoutCase) -> Path:
    output_root = Path(
        os.environ.get(_OUTPUT_DIR_ENV) or _DEFAULT_OUTPUT_ROOT
    ).resolve()
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_suffix = secrets.token_hex(4)
    root = output_root / f"{case.cve_id}-{run_id}-{run_suffix}"
    root.mkdir(parents=True, exist_ok=False)
    return root


def _checkout_vulnerable_commit(
    case: VulnerableCheckoutCase,
    workspace: Path,
) -> None:
    shutil.rmtree(workspace, ignore_errors=True)
    workspace.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "git",
            "clone",
            "--no-checkout",
            "--filter=blob:none",
            case.repo_url,
            str(workspace),
        ]
    )
    _run(["git", "checkout", case.vulnerable_commit], cwd=workspace)


def _write_issue_history(case: VulnerableCheckoutCase, history: Path) -> None:
    history.mkdir(parents=True, exist_ok=True)
    issue = _issue_metadata(case)
    write_json(history / "issue-metadata.json", issue)
    write_json(
        history / "linked-context.json",
        {
            "generated_at": utc_now_iso(),
            "relation_type": "cross-referenced",
            "source": "real-checkout-codegraph-test",
            "sources_checked": [],
            "issues": [],
            "prs": [],
        },
    )


def _issue_metadata(case: VulnerableCheckoutCase) -> dict[str, Any]:
    return {
        "action": "opened",
        "owner": "local",
        "repo": case.repo_name,
        "repo_full_name": f"local/{case.repo_name}",
        "number": "1",
        "html_url": f"local://real-checkout/{case.cve_id}",
        "title": case.title,
        "body": case.body,
        "author_login": "local-user",
        "labels": [],
        "default_branch": None,
    }


async def _run_analyzer_probe(
    *,
    case: VulnerableCheckoutCase,
    workspace: Path,
    history: Path,
    artifacts: Path,
    codegraph_enabled: bool,
) -> dict[str, Any]:
    artifacts.mkdir(parents=True, exist_ok=True)
    snapshot_tar = artifacts / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=workspace,
        tar_path=snapshot_tar,
    )
    with patch.dict(
        os.environ,
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_MCP_ENABLED": "true" if codegraph_enabled else "false",
        },
        clear=False,
    ):
        result = await analyze_issue(
            issue=_issue_metadata(case),
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            analyzer_artifacts_path=artifacts / "analyzer",
            review_objective="repair",
            runtime_context={"workspace_image": _WORKSPACE_IMAGE},
        )

    result_text = json.dumps(result, ensure_ascii=False).lower()
    return {
        "label": "with-codegraph" if codegraph_enabled else "filesystem-only",
        "verdict": result.get("verdict"),
        "mentionsKnownVulnerableFiles": _mentions_known_vulnerable_files(
            case,
            result_text,
        ),
        "toolUsage": tool_usage_from_transcript(
            artifacts / "analyzer" / "transcript.jsonl",
            observations=(_codegraph_tool_observation,),
        ),
        "result": result,
    }


def _mentions_known_vulnerable_files(
    case: VulnerableCheckoutCase,
    result_text: str,
) -> bool:
    files = {file_path.lower() for file_path in case.vulnerable_files}
    return any(file_path in result_text for file_path in files)


def _codegraph_tool_observation(usage: dict[str, Any]) -> dict[str, Any]:
    names = usage["toolNames"]
    return {
        "codegraphToolCalls": sum(name.startswith("codegraph_") for name in names),
        "usedCodeGraph": any(name.startswith("codegraph_") for name in names),
    }


def _run(
    command: list[str],
    *,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
