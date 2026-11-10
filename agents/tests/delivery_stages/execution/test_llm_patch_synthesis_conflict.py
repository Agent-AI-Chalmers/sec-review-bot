"""Real-LLM combined-delivery synthesis on contradictory and compatible cases.

Synthesis must commit nothing when two cases' repair intents contradict, and
must still merge cases that are compatible. A prompt alone did not hold: the
committed-patch correction pushed the agent to stitch contradictory logic
together until synthesis supplied its own empty-repair correction. The final
function is executed rather than string-matched, because equivalent
implementations carry no fixed wording. That
code is model-written, so it runs only in the Docker sandbox backend, never in
the pytest process.
"""

import json
import re
import subprocess
from pathlib import Path

import pytest

from sec_review_agents.delivery_stages.execution.input import DeliveryPatchCase
from sec_review_agents.delivery_stages.execution.stage import execute_delivery_entry
from sec_review_agents.delivery_stages.model import DeliveryEntry
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.filesystem.path_views import read_only_path_view
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.llm_probe import ProbeRequirement, llm_probe

pytestmark = [pytest.mark.integration, pytest.mark.llm]

PROBE = llm_probe(
    run_env="RUN_LLM_PATCH_SYNTHESIS_CONFLICT",
    description="real LLM patch synthesis conflict probe",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="Docker runtime",
            is_met=lambda: is_docker_runtime_available(default_docker_bin()),
            instruction="synthesis runs in the Docker sandbox; start Docker",
        ),
    ),
)

BASE = '''def export_format(requested: str) -> str:
    """Return the serialization format used for tenant exports."""
    return requested
'''
BAN_PICKLE = '''def export_format(requested: str) -> str:
    """Return the serialization format used for tenant exports."""
    if requested == "pickle":
        raise ValueError("pickle exports are forbidden")
    return requested
'''
FORCE_PICKLE = '''def export_format(requested: str) -> str:
    """Return the serialization format used for tenant exports."""
    # The signed restore path only reads pickle; every export must be pickle.
    return "pickle"
'''
# Compatible with BAN_PICKLE: it constrains the name's shape and says nothing
# about pickle. An allowlist that listed "pickle" read as a genuine conflict.
NAME_CHECK = '''def export_format(requested: str) -> str:
    """Return the serialization format used for tenant exports."""
    if not requested.isalnum():
        raise ValueError("invalid export format name")
    return requested
'''

# Loose, like the skill cases' explanation requirements: any wording that says
# the two intents cannot coexist.
_CONFLICT_PATTERN = re.compile(
    r"contradict|conflict|incompatib|mutually exclusive|irreconcil", re.IGNORECASE
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _case(repo: Path, case_id: str, content: str) -> DeliveryPatchCase:
    target = repo / "app" / "export.py"
    target.write_text(content, encoding="utf-8")
    diff = _git(repo, "diff")
    _git(repo, "checkout", "--", "app/export.py")
    return DeliveryPatchCase(
        case_id=case_id,
        mitigator_file_changes=[
            {
                "path": "app/export.py",
                "status": "upsert",
                "content": content,
                "content_encoding": "utf-8",
            }
        ],
        mitigator_patch_diff=diff,
    )


async def _synthesize(tmp_path: Path, case_a: str, case_b: str):
    repo = tmp_path / "repo"
    (repo / "app").mkdir(parents=True)
    (repo / "app" / "export.py").write_text(BASE, encoding="utf-8")
    _git(repo, "init", "-q")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "base")
    cases = [_case(repo, "case-a", case_a), _case(repo, "case-b", case_b)]
    snapshot = create_workspace_snapshot_tar(
        workspace_path=repo, tar_path=tmp_path / "baseline.tar"
    )
    return await execute_delivery_entry(
        run_artifacts_root=tmp_path / "artifacts",
        workspace_snapshot_tar_path=snapshot,
        delivery_entry=DeliveryEntry(
            delivery_id="delivery-1",
            strategy="combined",
            case_ids=["case-a", "case-b"],
            reason="Both cases change export_format in app/export.py",
        ),
        case_results=cases,
    )


# Imports the candidate module and reports export_format's behavior for each
# probe input as one JSON line on stdout.
_BEHAVIOR_HARNESS = """
import json, sys
sys.path.insert(0, "/probe")
from export import export_format
out = {}
for value in ("pickle", "json", "csv", "../etc"):
    try:
        out[value] = {"returns": export_format(value)}
    except Exception as error:
        out[value] = {"raises": type(error).__name__}
print(json.dumps(out))
"""


async def _export_format_behavior(result, tmp_path: Path) -> dict[str, dict[str, str]]:
    """Run the model-written export_format in the Docker sandbox backend.

    The merged code comes from a real model, so it never runs in the pytest
    process. The sandbox mounts only this probe directory read-only, has no
    network, and bounds the command with a timeout.
    """
    content = next(
        change["content"]
        for change in result.file_changes
        if change["path"] == "app/export.py"
    )
    probe = tmp_path / "behavior-probe"
    probe.mkdir()
    (probe / "export.py").write_text(content, encoding="utf-8")
    (probe / "harness.py").write_text(_BEHAVIOR_HARNESS, encoding="utf-8")
    backend = create_backend_with_path_views(
        container_name_prefix="synthesis-behavior",
        path_views=[
            read_only_path_view(host_path=probe, agent_path="/probe"),
        ],
        working_directory="/probe",
        backend_kind="docker",
    )
    async with amanaged_backend(backend):
        response = await backend.aexecute("python3 -I /probe/harness.py", timeout=60)
    assert response.exit_code == 0, response.output
    return json.loads(response.output.strip().splitlines()[-1])


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_contradictory_cases_fail_without_a_delivered_patch(
    tmp_path: Path,
) -> None:
    """An empty result alone also fits an agent that forgot to commit.

    The error must carry the agent's explanation naming both cases and the
    contradiction, which a forgotten commit would not produce.
    """
    result = await _synthesize(tmp_path, BAN_PICKLE, FORCE_PICKLE)

    assert result is not None
    assert result.status == "failed", result
    assert result.file_changes == []
    assert result.error is not None
    assert "Agent overview:" in result.error
    assert "case-a" in result.error and "case-b" in result.error, result.error
    assert _CONFLICT_PATTERN.search(result.error), result.error


@pytest.mark.skipif(not PROBE.enabled(), reason=PROBE.skip_reason())
@pytest.mark.asyncio
async def test_compatible_cases_merge_with_both_intents(tmp_path: Path) -> None:
    result = await _synthesize(tmp_path, BAN_PICKLE, NAME_CHECK)

    assert result is not None
    assert result.status == "ready", result
    behavior = await _export_format_behavior(result, tmp_path)
    assert behavior["pickle"] == {"raises": "ValueError"}, behavior
    assert behavior["../etc"] == {"raises": "ValueError"}, behavior
    assert behavior["json"] == {"returns": "json"}, behavior
    assert behavior["csv"] == {"returns": "csv"}, behavior
