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
from tests.integration.llm.skill_probe_helpers import (
    record_skill_probe_result,
    successful_read_paths,
)


class ReferenceSkillProbeOutput(BaseModel):
    verdict: Literal["confirmed", "not-confirmed"] = Field()
    skill_path_read: str = Field()
    reference_path_read: str = Field()
    precedent_applied: str = Field()
    rationale: str
    proof_gaps: list[str] = Field(default_factory=list)


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
            deployment_override=deployment,
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


def _parse_structured_response(
    result: dict,
    model: type[ReferenceSkillProbeOutput],
) -> ReferenceSkillProbeOutput:
    record_skill_probe_result(result, label="reference-smoke")
    parsed = result.get("structured_response")
    if isinstance(parsed, dict):
        parsed = model.model_validate(parsed)
    if not isinstance(parsed, model):
        raise AssertionError(f"missing structured response: {result!r}")
    assert isinstance(parsed, ReferenceSkillProbeOutput)
    reads = successful_read_paths(result)
    assert parsed.skill_path_read in reads
    assert parsed.reference_path_read in reads
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
        workspace.mkdir()
        (workspace / "tool.py").write_text(
            "import argparse\n"
            "from pathlib import Path\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('name', nargs='?')\n"
            "parser.add_argument('--output', default='/srv/reports/result.txt')\n"
            "args = parser.parse_args()\n"
            "Path(args.output).write_text('generated report')\n",
            encoding="utf-8",
        )
        (workspace / "handler.py").write_text(
            "import subprocess, sys\n"
            "from pathlib import Path\n"
            "def post_report(request):\n"
            "    tool = str(Path(__file__).with_name('tool.py'))\n"
            "    subprocess.run([sys.executable, tool, request.json['name']], check=True)\n",
            encoding="utf-8",
        )
        backend, agent = await _create_skill_probe_agent(workspace=workspace)
        async with amanaged_backend(backend):
            result = await _ask_reference_probe(
                agent,
                "Read /skills/web-security/SKILL.md and its command-injection "
                "reference. Inspect /workspace/handler.py and tool.py without "
                "executing them. post_report is an endpoint exposed to untrusted "
                "remote users, running as a service account that can overwrite "
                "its configuration under /srv/config. Users may request a report "
                "by name, not write arbitrary files. There is no earlier input "
                "validation. The lead supplies name='--output=/srv/config/runtime.json'. "
                "Assess how the downstream parser handles this value and its effect. "
                "Set skill_path_read and reference_path_read to the paths used.",
            )
        parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
        assert parsed.verdict == "confirmed"
        assert parsed.reference_path_read == (
            "/skills/web-security/references/command-injection.md"
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


@pytest.mark.parametrize(
    ("case", "source", "context", "reference", "expected"),
    [
        (
            "password-verifier",
            (
                "import hashlib\n"
                "def password_verifier(password):\n"
                "    return hashlib.sha256(password.encode()).hexdigest()\n"
            ),
            (
                "This is the production password storage function for user accounts. "
                "Assess offline password guessing if an attacker obtains the verifier "
                "database. No database disclosure path has been established."
            ),
            "auth-session",
            "confirmed",
        ),
        (
            "non-security-checksum",
            (
                "import hashlib\n"
                "def cache_key(public_image_bytes):\n"
                "    return hashlib.sha256(public_image_bytes).hexdigest()\n"
            ),
            (
                "This hashes public image bytes solely to address a cache. It is not "
                "a password verifier, authentication decision, or secrecy mechanism. "
                "Assess the lead that using a fast hash here weakens password storage."
            ),
            "auth-session",
            "not-confirmed",
        ),
        (
            "session-after-logout",
            (
                "sessions = {}\n"
                "def logout(token):\n"
                "    return {'delete_cookie': True}\n"
                "def account(token):\n"
                "    return sessions.get(token)\n"
            ),
            (
                "These are the deployed logout and authenticated-account handlers. "
                "A server-side session remains in sessions until logout invalidates it; "
                "there is no separate expiry/revocation layer. Product policy promises "
                "logout revokes that session. An attacker has copied the victim's old "
                "session token. Assess continued access after the victim logs out."
            ),
            "auth-session",
            "confirmed",
        ),
        (
            "account-lockout",
            (
                "locked = set()\n"
                "def login(user, password):\n"
                "    if user in locked: return False\n"
                "    if not verify_password(user, password):\n"
                "        locked.add(user)\n"
                "        return False\n"
                "    return True\n"
            ),
            (
                "This public login endpoint accepts any account name. One incorrect "
                "password permanently locks the named existing account. There is no "
                "rate gate, automatic expiry, alternate login or self-service recovery; "
                "only operator intervention restores access. Assess an unauthenticated "
                "attacker targeting a known victim account; password verification "
                "itself is correct."
            ),
            "auth-session",
            "confirmed",
        ),
        (
            "path-replacement",
            (
                "from pathlib import Path\n"
                "ROOT = Path('/srv/exports')\n"
                "def download(relative, checked, resume):\n"
                "    target = (ROOT / relative).resolve()\n"
                "    if not target.is_relative_to(ROOT): raise PermissionError()\n"
                "    checked.set()\n"
                "    resume.wait()\n"
                "    return target.read_bytes()\n"
            ),
            (
                "This service-account handler serves downloads. A lower-privileged "
                "local tenant can rename /srv/exports/slot and replace it with a "
                "symlink after checked fires and before resume is signalled. For "
                "relative='slot/secret', the original file passes containment. The "
                "replacement link points to /srv/private, which holds secret readable "
                "only by the service. No other guard constrains the subsequent read. "
                "Assess filesystem containment."
            ),
            "path-traversal",
            "confirmed",
        ),
        (
            "stable-path",
            (
                "from pathlib import Path\n"
                "ROOT = Path('/srv/exports')\n"
                "def download(relative):\n"
                "    target = (ROOT / relative).resolve()\n"
                "    if not target.is_relative_to(ROOT): raise PermissionError()\n"
                "    return target.read_bytes()\n"
            ),
            (
                "Requesters control relative. The root and every directory, link and "
                "file under it are immutable to them and all other untrusted actors "
                "during a request. All files there are intentionally public exports. "
                "Assess the lead that a separate resolve/check/read always permits "
                "a symlink race."
            ),
            "path-traversal",
            "not-confirmed",
        ),
        (
            "unknown-path-authority",
            (
                "from pathlib import Path\n"
                "def download(root, relative):\n"
                "    target = (root / relative).resolve()\n"
                "    if not target.is_relative_to(root): raise PermissionError()\n"
                "    return target.read_bytes()\n"
            ),
            (
                "The request controls relative; root is configured server-side. "
                "Directory permissions, possible concurrent writers and the contents "
                "of the export tree are not provided. Assess the claim that a tenant "
                "can replace a directory between check and read. Preserve unknown "
                "preconditions rather than inventing writable directories."
            ),
            "path-traversal",
            "not-confirmed",
        ),
    ],
    ids=[
        "password-verifier",
        "non-security-checksum",
        "session-after-logout",
        "account-lockout",
        "path-replacement",
        "stable-path",
        "unknown-path-authority",
    ],
)
async def test_corrected_reference_boundaries(
    tmp_path: Path,
    case: str,
    source: str,
    context: str,
    reference: str,
    expected: str,
) -> None:
    """Synthetic mechanism cases are independent of benchmark cases and outcomes."""
    workspace = tmp_path / case
    workspace.mkdir()
    (workspace / "handler.py").write_text(source, encoding="utf-8")
    backend, agent = await _create_skill_probe_agent(workspace=workspace)
    async with amanaged_backend(backend):
        result = await _ask_reference_probe(
            agent,
            "Read /skills/web-security/SKILL.md and its "
            f"{reference} reference, then inspect /workspace/handler.py. "
            f"{context} Return your verdict and explain the relevant conditions; "
            "Set skill_path_read and reference_path_read to the paths used. "
            "List material unknown preconditions in proof_gaps.",
        )
    parsed = _parse_structured_response(result, ReferenceSkillProbeOutput)
    assert parsed.verdict == expected
    assert (
        parsed.reference_path_read == f"/skills/web-security/references/{reference}.md"
    )
    if case == "unknown-path-authority":
        assert parsed.proof_gaps
