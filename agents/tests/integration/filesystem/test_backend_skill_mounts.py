import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from deepagents.middleware.skills import SkillsMiddleware

from sec_review_agents.agents.analysis.issue import create_issue_analyzer_backend
from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.agents.cvss.repository import create_repository_cvss_backend
from sec_review_agents.agents.delivery_planning.backend import (
    create_repository_delivery_planning_backend,
)
from sec_review_agents.agents.discovery.backend import (
    create_repository_discovery_backend,
)
from sec_review_agents.agents.mitigation.repository import (
    create_repository_mitigation_backend,
)
from sec_review_agents.agents.patch_synthesis.backend import (
    create_patch_synthesis_backend,
)
from sec_review_agents.agents.triage.backend import (
    create_repository_triage_backend,
)
from sec_review_agents.agents.verification.pull_request import (
    create_pr_verification_backend,
)
from sec_review_agents.agents.verification.repository import (
    create_repository_verification_backend,
)
from sec_review_agents.filesystem.bwrap_backend import BwrapSandboxBackend
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext


def _routes_for(backend) -> dict:
    composite = getattr(backend, "composite", backend)
    routes = getattr(composite, "routes", None)
    if isinstance(routes, dict):
        return routes
    raise AssertionError("Expected backend to expose composite routes.")


def _default_routes_for(backend) -> dict:
    routes = getattr(backend, "routes", None)
    if isinstance(routes, dict):
        return routes
    composite = getattr(backend, "composite", backend)
    default_backend = getattr(composite, "default", None)
    if default_backend is None:
        default_backend = getattr(backend, "default_backend", None)
    routes = getattr(default_backend, "routes", None)
    if isinstance(routes, dict):
        return routes
    raise AssertionError("Expected backend default to expose composite routes.")


def _route_root(backend, route: str) -> Path:
    route_backend = _routes_for(backend)[route]
    root_dir = getattr(route_backend, "root_dir", None)
    if isinstance(root_dir, Path):
        return root_dir
    raise AssertionError(f"Expected {route} to route to a local filesystem backend.")


def _default_route_root(backend, route: str) -> Path:
    route_backend = _default_routes_for(backend)[route]
    root_dir = getattr(route_backend, "root_dir", None)
    if isinstance(root_dir, Path):
        return root_dir
    raise AssertionError(f"Expected {route} to route to a local filesystem backend.")


def _route_writable(backend, route: str) -> bool:
    return bool(getattr(_routes_for(backend)[route], "writable", False))


def _default_route_writable(backend, route: str) -> bool:
    return bool(getattr(_default_routes_for(backend)[route], "writable", False))


def _local_root(input_data: dict) -> Path:
    return Path(input_data["input_bundle_uri"])


def _scan_mode(input_data: dict) -> str:
    return str((input_data.get("scan_target") or {}).get("scan_mode") or "full")


def _repository_analyzer_backend(
    input_data: dict,
    runtime_context: RunnerRuntimeContext | None = None,
):
    local_root = _local_root(input_data)
    scan_mode = _scan_mode(input_data)
    return create_repository_analyzer_backend(
        workspace_root_path=local_root / "workspace",
        history_path=local_root / "history" if scan_mode == "incremental" else None,
        incremental_window_path=(
            local_root / "incremental-window" if scan_mode == "incremental" else None
        ),
        scan_mode=scan_mode,
        runtime_context=runtime_context,
    )


def _repository_cvss_backend(input_data: dict):
    return create_repository_cvss_backend(
        workspace_root_path=_local_root(input_data) / "workspace",
    )


def _repository_mitigation_backend(input_data: dict, *, workspace_root: Path):
    local_root = _local_root(input_data)
    scan_mode = _scan_mode(input_data)
    return create_repository_mitigation_backend(
        workspace_root=workspace_root,
        history_path=local_root / "history" if scan_mode == "incremental" else None,
        incremental_window_path=(
            local_root / "incremental-window" if scan_mode == "incremental" else None
        ),
        scan_mode=scan_mode,
    )


def _repository_verification_backend(input_data: dict, *, workspace_root_path: Path):
    local_root = _local_root(input_data)
    scan_mode = _scan_mode(input_data)
    return create_repository_verification_backend(
        workspace_root_path=workspace_root_path,
        history_path=local_root / "history" if scan_mode == "incremental" else None,
        incremental_window_path=(
            local_root / "incremental-window" if scan_mode == "incremental" else None
        ),
        scan_mode=scan_mode,
    )


def _repository_delivery_planning_backend(input_data: dict):
    run_artifacts = Path(input_data["input_bundle_uri"]) / "artifacts"
    return create_repository_delivery_planning_backend(
        patch_root=run_artifacts / "delivery-planning" / "patches",
    )


def test_repository_review_backends_materialize_agent_skill_views(
    tmp_path: Path,
) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"
    analyzer_artifacts = run_artifacts / "cases" / "case-1" / "analyzer"
    verifier_artifacts = run_artifacts / "verifier"
    triage_artifacts = run_artifacts / "triage"

    workspace.mkdir(parents=True, exist_ok=True)
    analyzer_artifacts.mkdir(parents=True, exist_ok=True)
    verifier_artifacts.mkdir(parents=True, exist_ok=True)
    triage_artifacts.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
        "artifact_paths": {
            "analyzer": str(analyzer_artifacts),
            "verifier": str(verifier_artifacts),
            "triage": str(triage_artifacts),
        },
    }
    with (
        patch(
            "sec_review_agents.runtime.skills.tempfile.mkdtemp",
            side_effect=[
                str(root / "skills-root"),
                str(root / "skills-root-2"),
                str(root / "skills-root-3"),
                str(root / "skills-root-4"),
                str(root / "skills-root-5"),
                str(root / "skills-root-6"),
            ],
        ),
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
    ):
        analyzer_backend = _repository_analyzer_backend(input_data)
        verification_backend = _repository_verification_backend(
            input_data,
            workspace_root_path=workspace,
        )
        mitigation_backend = _repository_mitigation_backend(
            input_data,
            workspace_root=workspace,
        )
        cvss_backend = _repository_cvss_backend(input_data)
        delivery_planning_backend = _repository_delivery_planning_backend(input_data)
        patch_synthesis_backend = create_patch_synthesis_backend(
            workspace_root_path=workspace,
            workspace_writable=False,
        )
        discovery_backend = create_repository_discovery_backend()
        triage_backend = create_repository_triage_backend()

    assert "/skills/" in _default_routes_for(analyzer_backend)
    assert "/skills/" in _default_routes_for(verification_backend)
    assert "/skills/" in _routes_for(mitigation_backend)
    assert _default_route_root(analyzer_backend, "/workspace/") == workspace
    assert _default_route_writable(analyzer_backend, "/workspace/")
    assert _default_route_root(verification_backend, "/workspace/") == workspace
    assert _default_route_writable(verification_backend, "/workspace/")
    assert _route_root(cvss_backend, "/workspace/") == workspace
    assert _route_writable(cvss_backend, "/workspace/")

    analyzer_skills_root = _default_route_root(analyzer_backend, "/skills/")
    mitigation_skills_root = _route_root(mitigation_backend, "/skills/")
    verifier_skills_root = _default_route_root(verification_backend, "/skills/")
    assert (analyzer_skills_root / "cwe").is_dir()
    assert (analyzer_skills_root / "web-security").is_dir()
    assert (analyzer_skills_root / "ci-security").is_dir()
    assert (analyzer_skills_root / "language-framework-security").is_dir()
    assert not (mitigation_skills_root / "cwe").exists()
    assert (mitigation_skills_root / "web-security").is_dir()
    assert (mitigation_skills_root / "ci-security").is_dir()
    assert (mitigation_skills_root / "language-framework-security").is_dir()
    assert not (verifier_skills_root / "cwe").exists()
    assert (verifier_skills_root / "web-security").is_dir()
    assert (verifier_skills_root / "ci-security").is_dir()
    assert (verifier_skills_root / "language-framework-security").is_dir()
    assert not (analyzer_artifacts / "runtime" / "skills").exists()
    assert not (local_root / "resources" / "skills").exists()
    assert "/skills/" not in _routes_for(cvss_backend)
    assert "/skills/" not in _routes_for(delivery_planning_backend)
    delivery_planning_routes = _routes_for(delivery_planning_backend)
    assert "/workspace/" not in delivery_planning_routes
    assert "/patches/" in delivery_planning_routes
    assert "/skills/" not in _routes_for(patch_synthesis_backend)
    assert "/skills/" in _routes_for(discovery_backend)

    discovery_skills_root = _route_root(discovery_backend, "/skills/")
    assert not (discovery_skills_root / "cwe").exists()
    assert (discovery_skills_root / "web-security").is_dir()
    assert (discovery_skills_root / "ci-security").is_dir()
    assert (discovery_skills_root / "language-framework-security").is_dir()
    assert "/skills/" in _routes_for(triage_backend)
    triage_skills_root = _route_root(triage_backend, "/skills/")
    assert (triage_skills_root / "scanner-finding-triage").is_dir()
    assert not (triage_skills_root / "cwe").exists()
    assert not (triage_skills_root / "web-security").exists()
    assert not (triage_skills_root / "ci-security").exists()
    assert not (triage_skills_root / "language-framework-security").exists()
    assert "/triage/" not in _routes_for(triage_backend)


def test_review_backends_mount_materialized_memory_view_when_configured(
    tmp_path: Path,
) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    history = local_root / "history"
    incremental = local_root / "incremental-window"
    memory_source = root / "memory-source"
    memory_materialized = root / "memory-materialized"
    for path in (workspace, history, incremental, memory_source / "memory" / "topics"):
        path.mkdir(parents=True, exist_ok=True)
    (memory_source / "memory" / "MEMORY.md").write_text(
        "# Memory\n\n- Mounted memory lesson.\n",
        encoding="utf-8",
    )

    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "local",
            "AGENT_MEMORY_DIR": str(memory_source),
            "AGENT_MEMORY_MATERIALIZED_ROOT": str(memory_materialized),
        },
        clear=False,
    ):
        issue_backend = create_issue_analyzer_backend(
            workspace_root_path=workspace,
            history_path=history,
        )
        pr_backend = create_pr_verification_backend(
            workspace_root_path=workspace,
            history_path=history,
            incremental_window_path=incremental,
        )
        repository_backend = create_repository_mitigation_backend(
            workspace_root=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    for backend in (issue_backend, pr_backend, repository_backend):
        memory_root = _default_route_root(backend, "/memory/")
        assert memory_root.parent == memory_materialized.resolve()
        assert memory_root != memory_source.resolve()
        assert (memory_root / "MEMORY.md").read_text(encoding="utf-8") == (
            "# Memory\n\n- Mounted memory lesson.\n"
        )
        assert not _default_route_writable(backend, "/memory/")


def test_bwrap_env_reaches_workflow_backend_factory(tmp_path: Path) -> None:
    root = tmp_path
    workspace = root / "workspace"
    history = root / "history"
    workspace.mkdir()
    history.mkdir()

    with patch.dict(
        "os.environ",
        {"AGENT_SANDBOX_BACKEND": "bwrap"},
        clear=False,
    ):
        backend = create_issue_analyzer_backend(
            workspace_root_path=workspace,
            history_path=history,
        )

    assert isinstance(backend, BwrapSandboxBackend)
    assert backend._is_allowed_path("/workspace/app.py")
    assert not backend._is_allowed_path("/tmp/app.py")


def test_repository_analyzer_skills_middleware_loads_analysis_agent_skills(
    tmp_path: Path,
) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"
    analyzer_artifacts = run_artifacts / "cases" / "case-1" / "analyzer"

    workspace.mkdir(parents=True, exist_ok=True)
    analyzer_artifacts.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
        "artifact_paths": {"analyzer": str(analyzer_artifacts)},
    }
    with (
        patch(
            "sec_review_agents.runtime.skills.tempfile.mkdtemp",
            return_value=str(root / "skills-root"),
        ),
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
    ):
        analyzer_backend = _repository_analyzer_backend(input_data)

    middleware = SkillsMiddleware(backend=analyzer_backend, sources=["/skills/"])
    state_update = middleware.before_agent(
        {"messages": []},
        None,  # type: ignore[arg-type]  # Runtime is unused by this metadata load.
        {},
    )

    assert state_update is not None
    skills = state_update.get("skills_metadata") or []
    skills_by_name = {skill.get("name"): skill for skill in skills}
    cwe_skill = skills_by_name.get("cwe")
    web_skill = skills_by_name.get("web-security")
    ci_skill = skills_by_name.get("ci-security")
    language_skill = skills_by_name.get("language-framework-security")

    assert cwe_skill is not None
    assert cwe_skill["path"] == "/skills/cwe/SKILL.md"
    assert "CWE" in cwe_skill["description"]
    assert web_skill is not None
    assert web_skill["path"] == "/skills/web-security/SKILL.md"
    assert "web security" in web_skill["description"].lower()
    assert ci_skill is not None
    assert ci_skill["path"] == "/skills/ci-security/SKILL.md"
    assert "ci/cd" in ci_skill["description"].lower()
    assert language_skill is not None
    assert language_skill["path"] == "/skills/language-framework-security/SKILL.md"
    assert "language" in language_skill["description"].lower()


def test_repository_cvss_backend_exposes_tmp(tmp_path: Path) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"

    workspace.mkdir(parents=True, exist_ok=True)
    run_artifacts.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
    }

    cvss_backend = _repository_cvss_backend(input_data)
    routes = _routes_for(cvss_backend)

    assert "/workspace/" in routes
    assert "/tmp/" in routes


def test_repository_incremental_routes_are_mode_gated(tmp_path: Path) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"
    verifier_artifacts = run_artifacts / "verifier"
    triage_artifacts = run_artifacts / "triage"
    incremental_window = local_root / "incremental-window"
    history = local_root / "history"

    workspace.mkdir(parents=True, exist_ok=True)
    verifier_artifacts.mkdir(parents=True, exist_ok=True)
    triage_artifacts.mkdir(parents=True, exist_ok=True)
    incremental_window.mkdir(parents=True, exist_ok=True)
    history.mkdir(parents=True, exist_ok=True)

    artifact_paths = {
        "verifier": str(verifier_artifacts),
        "triage": str(triage_artifacts),
    }

    full_input = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
        "artifact_paths": artifact_paths,
    }
    incr_input = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "incremental"},
        "input_bundle_uri": str(local_root),
        "artifact_paths": artifact_paths,
    }
    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        analyzer_full_routes = _default_routes_for(
            _repository_analyzer_backend(full_input)
        )
        analyzer_incr_routes = _default_routes_for(
            _repository_analyzer_backend(incr_input)
        )
        triage_full_routes = _routes_for(create_repository_triage_backend())
        triage_incr_routes = _routes_for(create_repository_triage_backend())
        verifier_full_routes = _default_routes_for(
            _repository_verification_backend(
                full_input,
                workspace_root_path=workspace,
            )
        )
        verifier_incr_routes = _default_routes_for(
            _repository_verification_backend(
                incr_input,
                workspace_root_path=workspace,
            )
        )
        mitigation_full_routes = _routes_for(
            _repository_mitigation_backend(full_input, workspace_root=workspace)
        )
        mitigation_incr_routes = _routes_for(
            _repository_mitigation_backend(incr_input, workspace_root=workspace)
        )

    assert "/incremental-window/" not in analyzer_full_routes
    assert "/history/" not in analyzer_full_routes
    assert "/incremental-window/" in analyzer_incr_routes
    assert "/history/" in analyzer_incr_routes

    assert "/incremental-window/" not in triage_full_routes
    assert "/history/" not in triage_full_routes
    assert "/workspace/" not in triage_full_routes
    assert "/incremental-window/" not in triage_incr_routes
    assert "/history/" not in triage_incr_routes
    assert "/workspace/" not in triage_incr_routes

    assert "/incremental-window/" not in verifier_full_routes
    assert "/history/" not in verifier_full_routes
    assert "/incremental-window/" in verifier_incr_routes
    assert "/history/" in verifier_incr_routes

    assert "/incremental-window/" not in mitigation_full_routes
    assert "/history/" not in mitigation_full_routes
    assert "/incremental-window/" in mitigation_incr_routes
    assert "/history/" in mitigation_incr_routes


def test_repository_analyzer_local_tmp_write_is_host_tmp(tmp_path: Path) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"

    workspace.mkdir(parents=True, exist_ok=True)
    run_artifacts.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
    }

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="local",
    ):
        backend = _repository_analyzer_backend(input_data)

    marker = uuid.uuid4().hex
    virtual_path = f"/tmp/ghsb-local-{marker}.txt"
    host_path = Path(tempfile.gettempdir()) / f"ghsb-local-{marker}.txt"
    try:
        write_result = backend.write(virtual_path, "ok")
        assert write_result.error is None
        assert host_path.exists()
        assert host_path.read_text(encoding="utf-8") == "ok"
    finally:
        if host_path.exists():
            host_path.unlink()


def test_repository_verifier_rejects_missing_patched_workspace(tmp_path: Path) -> None:
    root = tmp_path
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-1"
    verifier_artifacts = run_artifacts / "verifier"

    workspace.mkdir(parents=True, exist_ok=True)
    verifier_artifacts.mkdir(parents=True, exist_ok=True)

    input_data = {
        "run_id": "run-1",
        "case": {"case_id": "case-1"},
        "scan_target": {"scan_mode": "full"},
        "input_bundle_uri": str(local_root),
        "artifact_paths": {"verifier": str(verifier_artifacts)},
    }

    with (
        patch(
            "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
            return_value="local",
        ),
        pytest.raises(FileNotFoundError),
    ):
        _repository_verification_backend(
            input_data,
            workspace_root_path=root / "missing-patched-workspace",
        )
