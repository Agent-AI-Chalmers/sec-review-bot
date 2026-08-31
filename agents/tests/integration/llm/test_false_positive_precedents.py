# Real-LLM regression smoke for the shared false-positive precedent prompt.
# It guards the important counterexample: "client-side auth is not an
# enforcement boundary" must not suppress a confirmed server-side authorization
# failure reachable through the same PR.

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.workflows.pull_request.analysis import analyze_pull_request
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.probe_helpers import llm_probe


def _confirmed_narratives(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [
        narrative
        for narrative in result.get("narratives", [])
        if isinstance(narrative, dict)
        and narrative.get("verdict") == "confirmed-vulnerability"
    ]


def _narrative_text(narrative: dict[str, Any]) -> str:
    return json.dumps(narrative, sort_keys=True).lower()


def _narrative_location_files(narrative: dict[str, Any]) -> set[str]:
    files: set[str] = set()
    for location in narrative.get("locations", []):
        if isinstance(location, dict) and isinstance(location.get("file"), str):
            files.add(location["file"])
    return files


def _is_client_only_auth_narrative(narrative: dict[str, Any]) -> bool:
    text = _narrative_text(narrative)
    locations = _narrative_location_files(narrative)
    mentions_client_auth = (
        "client-side" in text or "adminpanel" in text or "currentuser.isadmin" in text
    ) and ("auth" in text or "access control" in text)
    mentions_server_sink = (
        "src/server/admin.ts" in text
        or "/api/admin/users/:id/role" in text
        or "updaterole" in text
    )
    return (
        mentions_client_auth
        and not mentions_server_sink
        and bool(locations)
        and locations <= {"src/client/AdminPanel.tsx"}
    )


PROBE = llm_probe(
    run_env="RUN_LLM_FALSE_POSITIVE_PRECEDENT_INTEGRATION",
    description="real LLM false-positive precedent probe",
    requires_deployment=False,
)


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_client_side_auth_precedent_does_not_hide_server_authorization_failure(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    history = tmp_path / "history"
    incremental_window = tmp_path / "incremental-window"
    analyzer_artifacts = tmp_path / "artifacts" / "analyzer"

    (workspace / "src" / "server").mkdir(parents=True)
    (workspace / "src" / "client").mkdir(parents=True)
    history.mkdir(parents=True)
    incremental_window.mkdir(parents=True)
    analyzer_artifacts.mkdir(parents=True)

    (workspace / "src" / "server" / "admin.ts").write_text(
        "\n".join(
            [
                "import express from 'express'",
                "import { db } from './db'",
                "",
                "const router = express.Router()",
                "",
                "router.post('/api/admin/users/:id/role', async (req, res) => {",
                "  const requestedRole = String(req.body.role || '')",
                "  await db.users.updateRole(req.params.id, requestedRole)",
                "  res.json({ ok: true })",
                "})",
                "",
                "export default router",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (workspace / "src" / "client" / "AdminPanel.tsx").write_text(
        "\n".join(
            [
                "export function AdminPanel({ currentUser, selectedUser }) {",
                "  if (!currentUser.isAdmin) return null",
                "  return (",
                "    <button",
                "      onClick={() => fetch(`/api/admin/users/${selectedUser.id}/role`, {",
                "        method: 'POST',",
                "        headers: { 'content-type': 'application/json' },",
                "        body: JSON.stringify({ role: 'admin' })",
                "      })}",
                "    >Promote</button>",
                "  )",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )

    (incremental_window / "changed-files.json").write_text(
        json.dumps(
            {
                "generated_at": "2026-06-04T00:00:00Z",
                "files": [
                    {
                        "path": "src/server/admin.ts",
                        "status": "added",
                        "previous_path": None,
                        "additions": 12,
                        "deletions": 0,
                        "changes": 12,
                    },
                    {
                        "path": "src/client/AdminPanel.tsx",
                        "status": "added",
                        "previous_path": None,
                        "additions": 13,
                        "deletions": 0,
                        "changes": 13,
                    },
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (incremental_window / "incremental.patch").write_text(
        "\n".join(
            [
                "diff --git a/src/server/admin.ts b/src/server/admin.ts",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/src/server/admin.ts",
                "@@ -0,0 +1,12 @@",
                "+import express from 'express'",
                "+import { db } from './db'",
                "+",
                "+const router = express.Router()",
                "+",
                "+router.post('/api/admin/users/:id/role', async (req, res) => {",
                "+  const requestedRole = String(req.body.role || '')",
                "+  await db.users.updateRole(req.params.id, requestedRole)",
                "+  res.json({ ok: true })",
                "+})",
                "+",
                "+export default router",
                "diff --git a/src/client/AdminPanel.tsx b/src/client/AdminPanel.tsx",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/src/client/AdminPanel.tsx",
                "@@ -0,0 +1,13 @@",
                "+export function AdminPanel({ currentUser, selectedUser }) {",
                "+  if (!currentUser.isAdmin) return null",
                "+  return (",
                "+    <button",
                "+      onClick={() => fetch(`/api/admin/users/${selectedUser.id}/role`, {",
                "+        method: 'POST',",
                "+        headers: { 'content-type': 'application/json' },",
                "+        body: JSON.stringify({ role: 'admin' })",
                "+      })}",
                "+    >Promote</button>",
                "+  )",
                "+}",
                "",
            ]
        ),
        encoding="utf-8",
    )

    pr = {
        "title": "Add admin role promotion UI",
        "body": (
            "This PR mainly adds a client-side admin check before rendering "
            "the role promotion button. The UI hides the button for non-admin "
            "users, and the server helper endpoint is only intended to support "
            "that admin-only UI flow. Please review whether this role update "
            "flow is safe."
        ),
        "base_ref": "main",
        "base_sha": "base-sha",
        "head_ref": "admin-role-ui",
        "head_sha": "head-sha",
        "commit_shas": ["head-sha"],
    }

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        snapshot_tar = tmp_path / "workspace.snapshot.tar"
        create_workspace_snapshot_tar(
            workspace_path=workspace,
            tar_path=snapshot_tar,
        )
        result = await analyze_pull_request(
            pr=pr,
            workspace_snapshot_tar_path=snapshot_tar,
            history_path=history,
            incremental_window_path=incremental_window,
            analyzer_artifacts_path=analyzer_artifacts,
        )

    print(json.dumps(result, indent=2, sort_keys=True))
    assert result["verdict"] == "confirmed-vulnerability"
    confirmed_narratives = _confirmed_narratives(result)
    assert confirmed_narratives

    server_narratives = [
        narrative
        for narrative in confirmed_narratives
        if "src/server/admin.ts" in _narrative_text(narrative)
        and "/api/admin/users/:id/role" in _narrative_text(narrative)
        and "updaterole" in _narrative_text(narrative)
    ]
    assert server_narratives
    assert re.search(
        r"authori[sz]ation|access control|auth",
        _narrative_text(server_narratives[0]),
    )

    client_only_false_positives = [
        narrative
        for narrative in confirmed_narratives
        if _is_client_only_auth_narrative(narrative)
    ]
    assert client_only_false_positives == []
