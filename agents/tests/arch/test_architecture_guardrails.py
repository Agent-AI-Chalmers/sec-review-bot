"""Structural guardrails for package ownership and public seams.

These tests protect decisions that are easy to erode during refactors: where
shared components live, which packages own workflow-specific code, and which
files should remain thin entrypoints.
"""

import ast
import inspect

from tests.arch.architecture_test_helpers import PACKAGE_ROOT, import_violations


def test_workspace_patch_scope_does_not_use_standalone_change_contract() -> None:
    assert not (PACKAGE_ROOT / "runtime" / "changes.py").exists()
    assert not (PACKAGE_ROOT / "review_stages" / "changes.py").exists()
    assert not (PACKAGE_ROOT / "workspace" / "changes.py").exists()
    assert (PACKAGE_ROOT / "workspace" / "patches.py").exists()


def test_filesystem_owns_backend_composition() -> None:
    assert not (PACKAGE_ROOT / "workspace" / "backend_helpers.py").exists()
    assert not (PACKAGE_ROOT / "workspace" / "local_backend.py").exists()
    assert not (PACKAGE_ROOT / "workspace" / "material_backends.py").exists()
    assert (PACKAGE_ROOT / "filesystem" / "local_backend.py").exists()
    assert not (PACKAGE_ROOT / "filesystem" / "material_backends.py").exists()
    assert (PACKAGE_ROOT / "filesystem" / "backend_factory.py").exists()
    assert not (PACKAGE_ROOT / "filesystem" / "local_material_backend.py").exists()


def test_resources_own_resource_materialization() -> None:
    assert not (PACKAGE_ROOT / "workspace" / "resources.py").exists()
    assert (PACKAGE_ROOT / "resources" / "materialization.py").exists()


def test_runtime_package_stays_domain_neutral() -> None:
    runtime_root = PACKAGE_ROOT / "runtime"
    domain_name_parts = ("issue", "pull_request", "repository", "scan", "delivery")

    assert [
        str(path.relative_to(PACKAGE_ROOT))
        for path in runtime_root.glob("*.py")
        if any(part in path.stem for part in domain_name_parts)
    ] == []


def test_review_record_public_builders_are_review_record_builders() -> None:
    record_path = PACKAGE_ROOT / "review_stages" / "record.py"
    tree = ast.parse(record_path.read_text(encoding="utf-8"), filename=str(record_path))
    public_functions = [
        node.name
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and not node.name.startswith("_")
    ]

    assert public_functions
    assert [
        name
        for name in public_functions
        if not (name.startswith("build_") and name.endswith("_review_record"))
    ] == []


def test_review_record_does_not_own_domain_specific_builders() -> None:
    """Keep issue, pull-request, and repository rules out of the shared record builder.

    This check reads source because a domain lookup can be added without a new import
    or public function. Remove it only after tests directly prove that each workflow
    prepares its own data before calling the shared builder.
    """
    record_source = (PACKAGE_ROOT / "review_stages" / "record.py").read_text(
        encoding="utf-8"
    )
    forbidden_tokens = (
        "build_issue_review_record",
        "build_issue_single_agent_review_record",
        "build_pull_request_review_record",
        "build_repository_case_review_record",
        'input_data.get("issue")',
        'input_data.get("pullRequest")',
        'input_data.get("review_input")',
    )

    assert [token for token in forbidden_tokens if token in record_source] == []


def test_legacy_shared_review_workflow_does_not_return() -> None:
    """Keep orchestration in the domain workflows instead of reviving the old wrapper."""
    assert not (PACKAGE_ROOT / "review_stages" / "workflow.py").exists()


def test_issue_workflow_variants_stay_in_their_own_modules() -> None:
    """Keep each intentional issue workflow variant defined in its own module."""
    issue_workflow_root = PACKAGE_ROOT / "workflows" / "issue"
    variant_modules = {
        "single_agent.py": "IssueSingleAgentWorkflow",
        "two_stage.py": "IssueTwoStageWorkflow",
    }

    for filename, class_name in variant_modules.items():
        path = issue_workflow_root / filename
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        class_definitions = {
            node.name for node in tree.body if isinstance(node, ast.ClassDef)
        }
        assert class_name in class_definitions

    main_path = issue_workflow_root / "workflow.py"
    main_tree = ast.parse(
        main_path.read_text(encoding="utf-8"), filename=str(main_path)
    )
    main_class_definitions = {
        node.name for node in main_tree.body if isinstance(node, ast.ClassDef)
    }
    assert main_class_definitions.isdisjoint(variant_modules.values())


def test_workflow_input_preparation_is_a_single_entrypoints_module() -> None:
    assert (PACKAGE_ROOT / "entrypoints" / "input_preparation.py").is_file()
    assert not (PACKAGE_ROOT / "entrypoints" / "inputs").exists()
    assert not (PACKAGE_ROOT / "entrypoints" / "input_normalization.py").exists()


def test_local_materialization_is_cli_only() -> None:
    local_materialization_root = PACKAGE_ROOT / "cli" / "local_materialization"
    non_cli_roots = [
        path
        for path in PACKAGE_ROOT.iterdir()
        if path.is_dir() and path.name not in {"__pycache__", "cli"}
    ]
    violations: list[str] = []

    assert local_materialization_root.exists()

    for root in non_cli_roots:
        violations.extend(
            import_violations(
                root,
                ("sec_review_agents.cli.local_materialization",),
            )
        )

    assert violations == []


def test_local_cli_entrypoints_do_not_patch_import_paths() -> None:
    cli_root = PACKAGE_ROOT / "cli"
    violations: list[str] = []

    for path in cli_root.glob("run_local_*.py"):
        source = path.read_text(encoding="utf-8")
        for token in ("sys.path", "__package__"):
            if token in source:
                violations.append(f"{path.relative_to(PACKAGE_ROOT)} contains {token}")

    assert violations == []


def test_delivery_planning_agent_does_not_build_stage_result_contracts() -> None:
    """Keep model invocation separate from delivery-stage result projection."""
    agent_path = PACKAGE_ROOT / "agents" / "delivery_planning" / "agent.py"
    violations = import_violations(
        agent_path,
        ("sec_review_agents.delivery_stages.planning.result",),
    )

    assert violations == []


def test_delivery_result_builder_accepts_keep_case_ids() -> None:
    """Keep the result builder independent of workflow artifacts and agent models."""
    from sec_review_agents.delivery_stages.result import (
        build_delivery_result_from_outcomes,
    )

    signature = inspect.signature(build_delivery_result_from_outcomes)

    assert "keep_case_ids" in signature.parameters
    assert "keep_case_results" not in signature.parameters
    assert "run_artifacts_root" not in signature.parameters


def test_delivery_result_module_does_not_own_execution_results() -> None:
    """Keep execution outcomes out of the module that builds the final result.

    The forbidden names are a temporary ownership check. An import check would not
    catch the same execution classes or builders being recreated in this file, so keep
    this check until the handoff from execution has a direct behavior test.
    """
    source = (PACKAGE_ROOT / "delivery_stages" / "result.py").read_text(
        encoding="utf-8"
    )
    forbidden_tokens = (
        "DeliveryExecutionResult",
        "build_delivery_execution_result",
    )

    assert [token for token in forbidden_tokens if token in source] == []


def test_delivery_planning_stage_does_not_own_input_projection() -> None:
    """Keep case-to-planning data conversion out of the orchestration stage.

    These fields identify knowledge that belongs to planning input preparation. Keep
    this source check until an input/output test can prove that the preparation module,
    rather than the stage coordinator, owns that conversion.
    """
    source = (PACKAGE_ROOT / "delivery_stages" / "planning" / "stage.py").read_text(
        encoding="utf-8"
    )
    forbidden_tokens = (
        "write_text",
        "mitigation_overview",
        "mitigator_changed_files",
        "mitigator_patch_diff",
    )

    assert [token for token in forbidden_tokens if token in source] == []


def test_patch_synthesis_stays_inside_delivery_execution() -> None:
    """Keep the removed patch-synthesis package gone and its current owner explicit."""
    old_root = PACKAGE_ROOT / "delivery_stages" / "patch_synthesis"
    assert [path.name for path in old_root.glob("*.py")] == []

    path = PACKAGE_ROOT / "delivery_stages" / "execution" / "patch_synthesis.py"

    assert path.exists()
