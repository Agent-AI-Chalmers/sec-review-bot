# Real-LLM probes for bundled reference skills.
#
# These tests intentionally tell the model to read /skills. They are not natural
# trigger-rate tests and they do not measure full analyzer quality. They check the
# narrower contract that a model can read the mounted skill, route to the right
# reference, and apply a concrete precedent or source/sink rule.

import re
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from pydantic import BaseModel, Field

from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)
from sec_review_agents.runtime.summarization_middleware import (
    create_summarization_middleware,
)
from tests.integration.llm.deployment_helpers import llm_test_deployment
from tests.integration.llm.probe_helpers import llm_probe


class ReferenceSkillProbeOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed"] = Field()
    skill_path_read: str = Field()
    reference_path_read: str = Field()
    precedent_applied: str = Field()
    rationale: str


_PROBE_RECURSION_LIMIT = 64


async def _create_skill_probe_agent(
    *,
    workspace: Path,
):
    from sec_review_agents.agents.analysis.repository import (
        create_repository_analyzer_backend,
    )
    from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    deployment = llm_test_deployment()
    filesystem_middleware_prompt = (
        "You may read repository files and files under /skills. Use read_file "
        "when you need the full local skill instructions."
    )
    model = create_chat_model(
        agent_name="reference-skill-probe",
        deployment_override=deployment,
    )
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        SkillsMiddleware(backend=backend, sources=["/skills/"]),
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_middleware_prompt,
        ),
        create_summarization_middleware(
            agent_name="reference-skill-probe",
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    system_prompt = (
        "You are running a targeted reference-skill probe. Before answering, "
        "read the named /skills/*/SKILL.md file and then the single narrow "
        "reference it routes you to. Return structured output only."
    )
    agent = await build_agent_runtime_graph(
        model=model,
        agent_name="reference-skill-probe",
        backend=backend,
        system_prompt=system_prompt,
        response_format=ReferenceSkillProbeOutput,
        middleware=middleware,
    )
    return backend, agent


def _parse_structured_response[ParsedOutput: BaseModel](
    result: dict,
    model: type[ParsedOutput],
) -> ParsedOutput:
    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = model.model_validate(parsed)
    if not isinstance(parsed, model):
        raise AssertionError(f"missing structured response: {result!r}")
    return parsed


async def _ask_reference_probe(agent, content: str) -> dict:
    return await agent.ainvoke(
        {"messages": [{"role": "user", "content": content}]},
        config={"recursion_limit": _PROBE_RECURSION_LIMIT},
    )


PROBE = llm_probe(
    run_env="RUN_LLM_REFERENCE_SKILL_INTEGRATION",
    description="real LLM reference skill probes",
)


pytestmark = [PROBE.skip_unless(), pytest.mark.asyncio]


async def test_web_xss_reference_rejects_plain_react_interpolation() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "src").mkdir(parents=True)
        (workspace / "src" / "Profile.tsx").write_text(
            "\n".join(
                [
                    "type User = { displayName: string }",
                    "",
                    "export function Profile({ user }: { user: User }) {",
                    "  return <h1>{user.displayName}</h1>",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "XSS reference, and assess this lead: "
                "`src/Profile.tsx` renders attacker-controlled "
                "`user.displayName` inside `{user.displayName}`. "
                "Is this a confirmed XSS? Set skill_path_read and "
                "reference_path_read to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "not-confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == "/skills/web-security/references/xss.md"
        assert re.search(
            r"react|interpolation|escaping|escape",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_access_control_reference_rejects_client_boundary_only_claim() -> (
    None
):
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "src" / "client").mkdir(parents=True)
        (workspace / "src" / "server").mkdir(parents=True)
        (workspace / "src" / "client" / "AdminPanel.tsx").write_text(
            "\n".join(
                [
                    "export function AdminPanel({ currentUser, selectedUser }) {",
                    "  if (!currentUser.isAdmin) return null",
                    "  return <button onClick={() => promote(selectedUser.id)}>Promote</button>",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (workspace / "src" / "server" / "admin.ts").write_text(
            "\n".join(
                [
                    "export async function updateRole(req, res) {",
                    "  const actor = await requireSession(req)",
                    "  if (!actor.roles.includes('admin')) {",
                    "    res.status(403).end()",
                    "    return",
                    "  }",
                    "  await db.users.updateRole(req.params.id, req.body.role)",
                    "  res.json({ ok: true })",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "access-control reference, and assess this lead: "
                "`src/client/AdminPanel.tsx` has only a client-side "
                "admin visibility check, so non-admin users can call "
                "the role update API. Also inspect "
                "`src/server/admin.ts`. Is this a confirmed access "
                "control vulnerability? Set skill_path_read and "
                "reference_path_read to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "not-confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/web-security/references/access-control.md"
        )
        assert re.search(
            r"client|server|authori[sz]ation|trusted boundary|403",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_xss_reference_confirms_dangerous_react_html_sink() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "src").mkdir(parents=True)
        (workspace / "src" / "Announcement.tsx").write_text(
            "\n".join(
                [
                    "import { useSearchParams } from 'react-router-dom'",
                    "",
                    "export function Announcement() {",
                    "  const [params] = useSearchParams()",
                    "  const body = params.get('body') ?? ''",
                    "  return <section dangerouslySetInnerHTML={{ __html: body }} />",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "XSS reference, and assess this lead: "
                "`src/Announcement.tsx` reads the `body` query "
                "parameter and renders it with "
                "`dangerouslySetInnerHTML`. Is this a confirmed "
                "XSS? Set skill_path_read and reference_path_read to "
                "the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == "/skills/web-security/references/xss.md"
        assert re.search(
            r"query|dangerouslysetinnerhtml|raw html|sink|saniti[sz]",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_path_traversal_reference_confirms_uncontained_file_read() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "server").mkdir(parents=True)
        (workspace / "server" / "download.js").write_text(
            "\n".join(
                [
                    "const fs = require('fs')",
                    "const path = require('path')",
                    "",
                    "const root = path.join(__dirname, '..', 'exports')",
                    "",
                    "exports.download = async function download(req, res) {",
                    "  const name = req.query.file",
                    "  const target = path.join(root, name)",
                    "  const data = await fs.promises.readFile(target)",
                    "  res.type('application/octet-stream').send(data)",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "path traversal reference, and assess this lead: "
                "`server/download.js` joins `req.query.file` under "
                "an exports directory and passes the result to "
                "`fs.promises.readFile` without resolving and "
                "checking containment. Is this a confirmed path "
                "traversal? Set skill_path_read and reference_path_read "
                "to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/web-security/references/path-traversal.md"
        )
        assert re.search(
            r"req\.query|readfile|contain|resolve|traversal",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_command_injection_reference_confirms_argument_injection() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "pkg").mkdir(parents=True)
        (workspace / "pkg" / "vcs.py").write_text(
            "\n".join(
                [
                    "import subprocess",
                    "",
                    "def checkout(repo_type, checkout_ref, cwd):",
                    "    subprocess.check_output(",
                    "        [repo_type, 'checkout', checkout_ref],",
                    "        cwd=cwd,",
                    "    )",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "command-injection reference, and assess this lead: "
                "`pkg/vcs.py` passes caller-controlled "
                "`checkout_ref` as an argument-array element to "
                "`subprocess.check_output([repo_type, 'checkout', "
                "checkout_ref])`. For Mercurial, a value like "
                "`--config=hooks.pre-checkout=id` is parsed as an "
                "option and can execute a hook command. Is this a "
                "confirmed command/argument injection? Set "
                "skill_path_read and reference_path_read to the exact "
                "paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/web-security/references/command-injection.md"
        )
        assert re.search(
            r"argument|array|--config|hook|subprocess|flag|option",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_sql_injection_reference_confirms_untrusted_raw_order_clause() -> (
    None
):
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "api").mkdir(parents=True)
        (workspace / "api" / "reports.js").write_text(
            "\n".join(
                [
                    "exports.listReports = async function listReports(req, res) {",
                    "  const sort = req.query.sort || 'created_at desc'",
                    "  const rows = await db('reports')",
                    "    .where({ tenant_id: req.user.tenantId })",
                    "    .orderByRaw(sort)",
                    "  res.json(rows)",
                    "}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "SQL injection reference, and assess this lead: "
                "`api/reports.js` passes `req.query.sort` directly "
                "to `orderByRaw(sort)` with no allowlist of column "
                "or direction names. Is this a confirmed SQL "
                "injection? Set skill_path_read and reference_path_read "
                "to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/web-security/references/sql-injection.md"
        )
        assert re.search(
            r"orderbyraw|sort|identifier|allowlist|sql|structure",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_web_ssrf_reference_confirms_unvalidated_server_side_fetch() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / "service").mkdir(parents=True)
        (workspace / "service" / "preview.py").write_text(
            "\n".join(
                [
                    "import requests",
                    "from flask import request",
                    "",
                    "def preview():",
                    "    target = request.args['url']",
                    "    response = requests.get(target, timeout=5)",
                    "    return response.text[:4096]",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md, route to the "
                "SSRF reference, and assess this lead: "
                "`service/preview.py` reads `request.args['url']` "
                "and passes it directly to `requests.get`, then "
                "returns part of the response body. There is no "
                "scheme/host allowlist or private-network guard. "
                "Is this a confirmed SSRF? Set skill_path_read and "
                "reference_path_read to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/web-security/SKILL.md"
        assert parsed.reference_path_read == "/skills/web-security/references/ssrf.md"
        assert re.search(
            r"request\\.args|requests\\.get|server-side|fetch|host|private|ssrf",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_ci_github_actions_reference_rejects_pull_request_target_keyword_only() -> (
    None
):
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / ".github" / "workflows").mkdir(parents=True)
        (workspace / ".github" / "workflows" / "label-pr.yml").write_text(
            "\n".join(
                [
                    "name: Label PR",
                    "on:",
                    "  pull_request_target:",
                    "    types: [opened]",
                    "permissions:",
                    "  contents: read",
                    "  pull-requests: write",
                    "jobs:",
                    "  label:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - uses: actions/github-script@v7",
                    "        with:",
                    "          script: |",
                    "            await github.rest.issues.addLabels({",
                    "              owner: context.repo.owner,",
                    "              repo: context.repo.repo,",
                    "              issue_number: context.issue.number,",
                    "              labels: ['needs-review']",
                    "            })",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/ci-security/SKILL.md, route to the "
                "GitHub Actions reference, and assess this lead: "
                "`.github/workflows/label-pr.yml` uses "
                "`pull_request_target`, so fork authors can exploit "
                "the workflow. Is this a confirmed CI vulnerability "
                "from the workflow alone? Set skill_path_read and "
                "reference_path_read to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "not-confirmed"
        assert parsed.skill_path_read == "/skills/ci-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/ci-security/references/github-actions.md"
        )
        assert re.search(
            r"keyword|checkout|untrusted|sink|script|secrets|write",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )


async def test_ci_github_actions_reference_confirms_privileged_fork_code_execution() -> (
    None
):
    with tempfile.TemporaryDirectory() as tempdir:
        workspace = Path(tempdir) / "workspace"
        (workspace / ".github" / "workflows").mkdir(parents=True)
        (workspace / ".github" / "workflows" / "preview.yml").write_text(
            "\n".join(
                [
                    "name: Preview",
                    "on:",
                    "  pull_request_target:",
                    "permissions:",
                    "  contents: write",
                    "jobs:",
                    "  preview:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - uses: actions/checkout@v4",
                    "        with:",
                    "          ref: ${{ github.event.pull_request.head.sha }}",
                    "      - run: npm install",
                    "      - run: npm run preview",
                    "        env:",
                    "          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        backend, agent = await _create_skill_probe_agent(
            workspace=workspace,
        )
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/ci-security/SKILL.md, route to the "
                "GitHub Actions reference, and assess this lead: "
                "`.github/workflows/preview.yml` runs on "
                "`pull_request_target`, checks out "
                "`github.event.pull_request.head.sha`, then runs "
                "`npm install` and `npm run preview` with a secret "
                "environment variable. Is this a confirmed CI "
                "vulnerability? Set skill_path_read and "
                "reference_path_read to the exact paths you used.",
            )

        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        print(parsed.model_dump(by_alias=True))
        assert parsed.verdict == "confirmed"
        assert parsed.skill_path_read == "/skills/ci-security/SKILL.md"
        assert parsed.reference_path_read == (
            "/skills/ci-security/references/github-actions.md"
        )
        assert re.search(
            r"pull_request_target|head\.sha|fork|secret|untrusted|execute",
            f"{parsed.precedent_applied} {parsed.rationale}".lower(),
        )
