# Real-LLM issue-analyzer contrast for the bundled language-framework-security skill.
#
# Unlike the direct probe, this does not tell the model to read /skills. It runs
# the normal issue analyzer workflow in Docker twice, first with no analysis
# skills, then with only `language-framework-security`. The case is intentionally
# small and framework-semantic: Express middleware order determines whether an
# admin route is protected.

import json
import os
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.utils.files import write_json
from sec_review_agents.utils.time import utc_now_iso
from sec_review_agents.workflows.issue.analysis import analyze_issue
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe
from tests.integration.llm.transcript_artifact_helpers import (
    empty_tool_usage,
    tool_usage_from_transcript,
)

_RUN_ENV = "RUN_LLM_LANGUAGE_FRAMEWORK_SKILL_CONTRAST"
_BRANCH_ENV = "LANGUAGE_FRAMEWORK_SKILL_CONTRAST_BRANCH"
_OUTPUT_DIR_ENV = "LANGUAGE_FRAMEWORK_SKILL_CONTRAST_OUTPUT_DIR"
_DEFAULT_OUTPUT_ROOT = Path(".agent-artifacts/language-framework-skill-contrast")
_BRANCH_BOTH = "both"
_BRANCH_WITH = "with"
_BRANCH_WITHOUT = "without"
_BRANCH_VALUES = {_BRANCH_BOTH, _BRANCH_WITH, _BRANCH_WITHOUT}


@dataclass(frozen=True)
class LanguageFrameworkIssueCase:
    case_id: str
    repo_name: str
    title: str
    body: str
    expected_files: tuple[str, ...]
    expected_terms: tuple[str, ...]


_EXPRESS_MIDDLEWARE_ORDER_CASE = LanguageFrameworkIssueCase(
    case_id="EXPRESS-MIDDLEWARE-ORDER",
    repo_name="express-admin-export",
    title="Audit a disputed Express middleware-order report",
    body=(
        "A security report claims an Express admin export endpoint is reachable "
        "without authentication because the route is registered before the "
        "authentication middleware. A reviewer pushed back that the app calls "
        "`app.use(requireAuth)`, so all later route handling should be protected. "
        "Audit the prepared repository and decide whether the report is a real "
        "authentication bypass or a false positive. Focus on repository evidence "
        "for how Express route and middleware ordering affects the endpoint.\n\n"
        "CWE:\n"
        "- CWE-306: Missing Authentication for Critical Function"
    ),
    expected_files=("src/app.js",),
    expected_terms=("express", "middleware", "order", "admin/export", "authentication"),
)


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


PROBE = llm_probe(
    run_env=_RUN_ENV,
    description="real LLM language/framework skill contrast analyzer probe",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="Docker runtime",
            is_met=_docker_available,
            instruction="ensure Docker is available",
        ),
    ),
)


@PROBE.skip_unless()
@pytest.mark.asyncio
async def test_express_middleware_order_with_and_without_language_framework_skill() -> (
    None
):
    case = _EXPRESS_MIDDLEWARE_ORDER_CASE
    root = _create_run_root(case)
    workspace = root / "workspace"
    history = root / "history"
    artifacts = root / "artifacts"

    _write_express_workspace(workspace)
    _write_issue_history(case, history)

    branch = _contrast_branch()
    without_language_framework = (
        await _run_issue_analyzer_probe(
            case=case,
            workspace=workspace,
            history=history,
            artifacts=artifacts / "without-language-framework",
            include_language_framework_skill=False,
        )
        if branch in {_BRANCH_BOTH, _BRANCH_WITHOUT}
        else _skipped_probe_result("without-language-framework")
    )
    with_language_framework = (
        await _run_issue_analyzer_probe(
            case=case,
            workspace=workspace,
            history=history,
            artifacts=artifacts / "with-language-framework",
            include_language_framework_skill=True,
        )
        if branch in {_BRANCH_BOTH, _BRANCH_WITH}
        else _skipped_probe_result("with-language-framework")
    )

    summary_path = root / "language-framework-skill-contrast-summary.json"
    summary = {
        "run_root": str(root),
        "summaryPath": str(summary_path),
        "workspace": str(workspace),
        "history": str(history),
        "artifacts": str(artifacts),
        "case_id": case.case_id,
        "repo": case.repo_name,
        "branch": branch,
        "attribution": _attribution_summary(
            without_language_framework,
            with_language_framework,
        ),
        "withoutLanguageFramework": without_language_framework,
        "withLanguageFramework": with_language_framework,
    }
    write_json(summary_path, summary)
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    if with_language_framework["status"] == "skipped":
        return
    assert with_language_framework["toolUsage"]["readLanguageFrameworkSkill"], (
        "with-skill branch must read the language/framework reference for attribution; "
        "an invalid skills:* tool call does not count"
    )
    if without_language_framework["status"] != "skipped":
        assert not without_language_framework["toolUsage"][
            "readLanguageFrameworkSkill"
        ], (
            "without-skill branch must not be able to use the language/framework "
            "reference"
        )
    result = with_language_framework["result"]
    result_text = json.dumps(result, ensure_ascii=False).lower()
    assert result.get("verdict") == "confirmed-vulnerability"
    for expected_file in case.expected_files:
        assert expected_file in result_text
    for expected_term in case.expected_terms:
        assert expected_term in result_text


def _contrast_branch() -> str:
    branch = os.environ.get(_BRANCH_ENV, _BRANCH_BOTH).strip().lower()
    if branch not in _BRANCH_VALUES:
        raise ValueError(
            f"{_BRANCH_ENV} must be one of {sorted(_BRANCH_VALUES)}, got {branch!r}"
        )
    return branch


def _skipped_probe_result(label: str) -> dict[str, Any]:
    return {
        "label": label,
        "verdict": None,
        "status": "skipped",
        "mentionsExpectedFiles": False,
        "expectedTermsHit": {},
        "toolUsage": _empty_tool_usage(),
        "result": None,
    }


def _attribution_summary(
    without_language_framework: dict[str, Any],
    with_language_framework: dict[str, Any],
) -> dict[str, Any]:
    without_tools = without_language_framework["toolUsage"]
    with_tools = with_language_framework["toolUsage"]
    return {
        "withoutVerdict": without_language_framework["verdict"],
        "withVerdict": with_language_framework["verdict"],
        "withoutStatus": without_language_framework["status"],
        "withStatus": with_language_framework["status"],
        "withoutReadLanguageFrameworkSkill": without_tools[
            "readLanguageFrameworkSkill"
        ],
        "withReadLanguageFrameworkSkill": with_tools["readLanguageFrameworkSkill"],
        "withoutInvalidLanguageFrameworkSkillToolCalls": without_tools[
            "invalidLanguageFrameworkSkillToolCalls"
        ],
        "withInvalidLanguageFrameworkSkillToolCalls": with_tools[
            "invalidLanguageFrameworkSkillToolCalls"
        ],
        "withoutGitCommandCalls": without_tools["gitCommandCalls"],
        "withGitCommandCalls": with_tools["gitCommandCalls"],
        "withoutTotalToolCalls": without_tools["totalToolCalls"],
        "withTotalToolCalls": with_tools["totalToolCalls"],
    }


def _empty_tool_usage() -> dict[str, Any]:
    return empty_tool_usage(observations=(_language_framework_tool_observation,))


def _create_run_root(case: LanguageFrameworkIssueCase) -> Path:
    output_root = Path(
        os.environ.get(_OUTPUT_DIR_ENV) or _DEFAULT_OUTPUT_ROOT
    ).resolve()
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    run_suffix = secrets.token_hex(4)
    root = output_root / f"{case.case_id}-{run_id}-{run_suffix}"
    root.mkdir(parents=True, exist_ok=False)
    return root


def _write_express_workspace(
    workspace: Path,
) -> None:
    (workspace / "src").mkdir(parents=True)
    write_json(
        workspace / "package.json",
        {
            "name": "express-admin-export",
            "version": "1.0.0",
            "dependencies": {"express": "^4.18.0"},
        },
    )
    (workspace / "src" / "app.js").write_text(
        "\n".join(
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
                "module.exports = app;",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _write_issue_history(case: LanguageFrameworkIssueCase, history: Path) -> None:
    history.mkdir(parents=True, exist_ok=True)
    write_json(history / "issue-metadata.json", _issue_metadata(case))
    write_json(
        history / "linked-context.json",
        {
            "generated_at": utc_now_iso(),
            "relation_type": "cross-referenced",
            "source": "language-framework-skill-contrast-test",
            "sources_checked": [],
            "issues": [],
            "prs": [],
        },
    )


def _issue_metadata(case: LanguageFrameworkIssueCase) -> dict[str, Any]:
    return {
        "action": "opened",
        "owner": "local",
        "repo": case.repo_name,
        "repo_full_name": f"local/{case.repo_name}",
        "number": "1",
        "html_url": f"local://case/{case.case_id}",
        "title": case.title,
        "body": case.body,
        "author_login": "local-user",
        "labels": [],
        "default_branch": None,
    }


async def _run_issue_analyzer_probe(
    *,
    case: LanguageFrameworkIssueCase,
    workspace: Path,
    history: Path,
    artifacts: Path,
    include_language_framework_skill: bool,
) -> dict[str, Any]:
    artifacts.mkdir(parents=True, exist_ok=True)
    snapshot_tar = artifacts / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(
        workspace_path=workspace,
        tar_path=snapshot_tar,
    )
    skill_names = (
        ("language-framework-security",) if include_language_framework_skill else ()
    )
    with (
        _docker_environment(),
        patch(
            "sec_review_agents.agents.analysis.issue.ANALYSIS_AGENT_SKILLS",
            skill_names,
        ),
    ):
        result = await analyze_issue(
            issue=_issue_metadata(case),
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            analyzer_artifacts_path=artifacts / "analyzer",
            review_objective="repair",
        )
    result_text = json.dumps(result, ensure_ascii=False).lower()
    return {
        "label": (
            "with-language-framework"
            if include_language_framework_skill
            else "without-language-framework"
        ),
        "verdict": result.get("verdict"),
        "status": result.get("status"),
        "mentionsExpectedFiles": all(
            expected_file in result_text for expected_file in case.expected_files
        ),
        "expectedTermsHit": {
            expected_term: expected_term in result_text
            for expected_term in case.expected_terms
        },
        "toolUsage": _language_framework_tool_usage(
            artifacts / "analyzer" / "transcript.json"
        ),
        "result": result,
    }


def _docker_environment():
    return patch.dict(
        os.environ,
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_MCP_ENABLED": "false",
        },
        clear=False,
    )


def _language_framework_tool_usage(messages_dir: Path) -> dict[str, Any]:
    return tool_usage_from_transcript(
        messages_dir,
        observations=(_language_framework_tool_observation,),
    )


def _language_framework_tool_observation(usage: dict[str, Any]) -> dict[str, Any]:
    names = usage["toolNames"]
    read_paths = usage["readPaths"]
    language_framework_paths = [
        path
        for path in read_paths
        if path.startswith("/skills/language-framework-security/")
    ]
    invalid_language_framework_skill_tool_calls = sum(
        name == "skills:language-framework-security" for name in names
    )
    skill_paths = [path for path in read_paths if path.startswith("/skills/")]
    return {
        "readLanguageFrameworkSkill": bool(language_framework_paths),
        "invalidLanguageFrameworkSkillToolCalls": (
            invalid_language_framework_skill_tool_calls
        ),
        "readLanguageFrameworkPaths": language_framework_paths,
        "readSkillPaths": skill_paths,
    }
