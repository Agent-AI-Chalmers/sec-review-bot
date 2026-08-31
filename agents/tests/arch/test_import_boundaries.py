"""Import-boundary guardrails for the agent package.

Prefer forbidden directions and cycle checks over full import graph snapshots.
The goal is to catch layer inversions and accidental orchestration imports
without making every reasonable utility dependency a test maintenance event.
"""

import ast
import os
import subprocess
import sys

from tests.arch.architecture_test_helpers import (
    PACKAGE_ROOT,
    import_violations,
    module_import_edges,
    strongly_connected_modules,
)


def test_capability_packages_do_not_import_legacy_domain_shims() -> None:
    capability_roots = [
        PACKAGE_ROOT / "scan_stages",
        PACKAGE_ROOT / "review_stages",
        PACKAGE_ROOT / "delivery_stages",
        PACKAGE_ROOT / "workflows",
    ]
    legacy_prefixes = (
        "sec_review_agents.issues",
        "sec_review_agents.pull_requests",
        "sec_review_agents.repositories",
    )
    violations: list[str] = []

    for root in capability_roots:
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    if module.startswith(legacy_prefixes):
                        violations.append(
                            f"{path.relative_to(PACKAGE_ROOT)} imports {module}"
                        )
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name.startswith(legacy_prefixes):
                            violations.append(
                                f"{path.relative_to(PACKAGE_ROOT)} imports {alias.name}"
                            )

    assert violations == []


def test_foundational_packages_do_not_import_upper_layers() -> None:
    # Keep this as a one-way layering check. Foundational packages may share
    # small helpers, but they should not pull in workflows, runners, or stages.
    foundational_roots = [
        PACKAGE_ROOT / "utils",
        PACKAGE_ROOT / "resources",
        PACKAGE_ROOT / "workspace",
        PACKAGE_ROOT / "filesystem",
    ]
    forbidden_prefixes = (
        "sec_review_agents.cli",
        "sec_review_agents.delivery_stages",
        "sec_review_agents.llm",
        "sec_review_agents.mcp",
        "sec_review_agents.memory",
        "sec_review_agents.observability",
        "sec_review_agents.review_stages",
        "sec_review_agents.runner",
        "sec_review_agents.runtime",
        "sec_review_agents.scan_stages",
        "sec_review_agents.temporal",
        "sec_review_agents.workflows",
    )
    violations: list[str] = []

    for root in foundational_roots:
        violations.extend(import_violations(root, forbidden_prefixes))

    assert violations == []


def test_delivery_stages_do_not_import_repository_workflow_orchestration() -> None:
    delivery_root = PACKAGE_ROOT / "delivery_stages"
    forbidden_prefixes = (
        "sec_review_agents.repository_cases",
        "sec_review_agents.workflows.repository.",
        "sec_review_agents.workflows.repository_case.stage",
    )
    violations = import_violations(delivery_root, forbidden_prefixes)

    assert violations == []


def test_filesystem_backend_factory_stays_domain_neutral() -> None:
    backend_factory_path = PACKAGE_ROOT / "filesystem" / "backend_factory.py"
    source = backend_factory_path.read_text(encoding="utf-8")
    allowed_framework_tokens = ("/conversation_history",)
    for token in allowed_framework_tokens:
        source = source.replace(token, "")
    forbidden_tokens = (
        "history",
        "incremental",
        "verifier",
        "issue",
        "pull_request",
        "pull-request",
        "repository",
    )

    assert [token for token in forbidden_tokens if token in source] == []


def test_runtime_package_does_not_import_domain_or_workflow_packages() -> None:
    runtime_root = PACKAGE_ROOT / "runtime"
    violations = import_violations(
        runtime_root,
        (
            "sec_review_agents.scan_stages",
            "sec_review_agents.review_stages",
            "sec_review_agents.delivery_stages",
            "sec_review_agents.workflows",
        ),
    )

    assert violations == []


def test_review_stages_package_does_not_own_workflow_specific_implementations() -> None:
    review_stages_root = PACKAGE_ROOT / "review_stages"
    forbidden_paths = [
        review_stages_root / "backends",
        review_stages_root / "strategies",
        review_stages_root / "issue_prompt_mode.py",
    ]
    forbidden_name_parts = ("issue", "pull_request", "repository")
    violations = [
        str(path.relative_to(PACKAGE_ROOT)) for path in forbidden_paths if path.exists()
    ]
    violations.extend(
        str(path.relative_to(PACKAGE_ROOT))
        for path in review_stages_root.rglob("*.py")
        if any(part in path.stem for part in forbidden_name_parts)
    )

    assert violations == []


def test_review_single_agent_core_stays_workflow_neutral() -> None:
    single_agent_root = PACKAGE_ROOT / "review_stages" / "single_agent"
    single_agent_agent_root = PACKAGE_ROOT / "agents" / "single_agent"
    expected_stage_files = {
        "__init__.py",
        "result.py",
        "stage.py",
    }
    expected_agent_files = {
        "__init__.py",
        "agent.py",
        "issue.py",
        "mcp.py",
        "model.py",
        "skills.py",
    }
    forbidden_tokens = (
        "IssueReviewInput",
        "PullRequestReviewInput",
        "RepositoryReviewInput",
        "sec_review_agents.workflows.issue",
        "sec_review_agents.workflows.pull_request",
        "sec_review_agents.workflows.repository",
        'input_data["issue"]',
        'input_data.get("issue")',
        "issue-review",
        "pull-request-review",
        "repository-review",
    )
    violations: list[str] = []

    assert single_agent_root.exists()
    assert single_agent_agent_root.exists()
    assert {
        path.name for path in single_agent_root.glob("*.py")
    } == expected_stage_files
    assert {
        path.name for path in single_agent_agent_root.glob("*.py")
    } == expected_agent_files

    for path in (
        *single_agent_root.rglob("*.py"),
        *(
            path
            for path in single_agent_agent_root.rglob("*.py")
            if path.name != "issue.py"
        ),
    ):
        source = path.read_text(encoding="utf-8")
        for token in forbidden_tokens:
            if token in source:
                violations.append(f"{path.relative_to(PACKAGE_ROOT)} contains {token}")

    assert violations == []


def test_observability_package_does_not_import_workspace() -> None:
    observability_root = PACKAGE_ROOT / "observability"
    violations = import_violations(
        observability_root,
        ("sec_review_agents.workspace",),
    )

    assert violations == []


def test_workspace_package_does_not_import_observability() -> None:
    workspace_root = PACKAGE_ROOT / "workspace"
    violations = import_violations(
        workspace_root,
        ("sec_review_agents.observability",),
    )

    assert violations == []


def test_foundational_packages_do_not_import_runner_runtime_input_preparation() -> None:
    foundational_roots = [
        PACKAGE_ROOT / "filesystem",
        PACKAGE_ROOT / "workspace",
    ]
    violations: list[str] = []

    for root in foundational_roots:
        violations.extend(
            import_violations(
                root,
                ("sec_review_agents.runner.input_preparation",),
            )
        )

    assert violations == []


def test_runner_core_and_service_do_not_leak_into_workflow_input_consumers() -> None:
    roots = [
        PACKAGE_ROOT / "cli",
        PACKAGE_ROOT / "workflows",
    ]
    violations: list[str] = []

    for root in roots:
        violations.extend(
            import_violations(
                root,
                (
                    "sec_review_agents.runner.core",
                    "sec_review_agents.runner.service",
                ),
            )
        )

    assert violations == []


def test_runner_input_preparation_import_does_not_eagerly_load_runner_core() -> None:
    src_root = str(PACKAGE_ROOT.parent)
    env = {
        **os.environ,
        "PYTHONPATH": (
            src_root
            if not os.environ.get("PYTHONPATH")
            else f"{src_root}{os.pathsep}{os.environ['PYTHONPATH']}"
        ),
    }
    script = """
import json
import sys

import sec_review_agents.runner.input_preparation

prefixes = (
    "sec_review_agents.runner.core",
    "sec_review_agents.workflows",
    "sec_review_agents.llm",
    "sec_review_agents.runtime",
)
print(json.dumps(sorted(name for name in sys.modules if name.startswith(prefixes))))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        env=env,
        text=True,
    )

    assert result.stdout.strip() == "[]"


def test_runner_core_does_not_import_stage_modules() -> None:
    runner_path = PACKAGE_ROOT / "runner" / "core.py"
    assert runner_path.exists()
    violations = import_violations(
        runner_path,
        (
            "sec_review_agents.review_stages.analysis.stage",
            "sec_review_agents.review_stages.mitigation.stage",
            "sec_review_agents.review_stages.verification.stage",
            "sec_review_agents.scan_stages.discovery.stage",
            "sec_review_agents.scan_stages.triage.stage",
            "sec_review_agents.delivery_stages.planning.stage",
        ),
    )

    assert violations == []


def test_internal_modules_do_not_have_import_cycles() -> None:
    module_edges = module_import_edges()
    violations = strongly_connected_modules(module_edges)

    assert violations == []


def test_scan_stages_package_does_not_import_review_or_delivery() -> None:
    scan_root = PACKAGE_ROOT / "scan_stages"
    forbidden_prefixes = (
        "sec_review_agents.review_stages",
        "sec_review_agents.delivery_stages",
    )
    violations = import_violations(scan_root, forbidden_prefixes)

    assert violations == []


def test_delivery_stages_package_does_not_import_review_stage_implementations() -> None:
    delivery_root = PACKAGE_ROOT / "delivery_stages"
    forbidden_prefixes = (
        "sec_review_agents.review_stages.analysis",
        "sec_review_agents.review_stages.mitigation",
        "sec_review_agents.review_stages.verification",
        "sec_review_agents.workflows.repository_case.cvss",
    )
    violations = import_violations(delivery_root, forbidden_prefixes)

    assert violations == []


def test_delivery_stages_do_not_import_workflow_packages() -> None:
    delivery_root = PACKAGE_ROOT / "delivery_stages"
    violations: list[str] = []

    for path in delivery_root.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            module = ""
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    module = alias.name
                    if module.startswith("sec_review_agents.workflows"):
                        violations.append(
                            f"{path.relative_to(PACKAGE_ROOT)} imports {module}"
                        )
                continue
            if module.startswith("sec_review_agents.workflows"):
                violations.append(f"{path.relative_to(PACKAGE_ROOT)} imports {module}")

    assert violations == []


def test_workflow_entrypoints_stay_thin() -> None:
    workflow_paths = [
        PACKAGE_ROOT / "workflows" / "issue" / "__init__.py",
        PACKAGE_ROOT / "workflows" / "pull_request" / "__init__.py",
        PACKAGE_ROOT / "workflows" / "repository" / "__init__.py",
    ]
    forbidden_prefixes = (
        "sec_review_agents.review_stages.analysis",
        "sec_review_agents.review_stages.mitigation",
        "sec_review_agents.review_stages.verification",
        "sec_review_agents.review_stages.single_agent",
        "sec_review_agents.review_stages.workflow",
    )
    violations: list[str] = []

    for path in workflow_paths:
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module.startswith(forbidden_prefixes):
                    violations.append(
                        f"{path.relative_to(PACKAGE_ROOT)} imports {module}"
                    )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith(forbidden_prefixes):
                        violations.append(
                            f"{path.relative_to(PACKAGE_ROOT)} imports {alias.name}"
                        )

    assert violations == []
