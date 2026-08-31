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


def test_review_stages_package_declares_components_loop_and_single_agent_core() -> None:
    init_source = (PACKAGE_ROOT / "review_stages" / "__init__.py").read_text(
        encoding="utf-8"
    )

    assert "stage components" in init_source
    assert "feedback loop" in init_source
    assert "single-agent fix strategies" in init_source
    assert "default staged wrapper" not in init_source
    assert "review_stages.workflow" not in init_source


def test_issue_and_pull_request_workflows_are_temporal_entrypoints() -> None:
    assert not (PACKAGE_ROOT / "review_stages" / "workflow.py").exists()
    workflow_paths = [
        PACKAGE_ROOT / "workflows" / "issue" / "workflow.py",
        PACKAGE_ROOT / "workflows" / "pull_request" / "workflow.py",
    ]

    for path in workflow_paths:
        source = path.read_text(encoding="utf-8")
        assert "from temporalio import activity, workflow" in source
        assert "execute_issue_review_workflow" not in source
        assert "execute_pull_request_review_workflow" not in source
        assert "FeedbackLoopConfig" not in source
        assert "DefaultReviewWorkflow" not in source
        assert "run_default_review_workflow" not in source

    issue_workflow_source = workflow_paths[0].read_text(encoding="utf-8")
    assert "IssueSingleAgentWorkflow" not in issue_workflow_source
    assert "IssueTwoStageWorkflow" not in issue_workflow_source
    assert "prepare_issue_single_agent_workflow_activity" not in issue_workflow_source

    assert "IssueSingleAgentWorkflow" in (
        PACKAGE_ROOT / "workflows" / "issue" / "single_agent.py"
    ).read_text(encoding="utf-8")
    assert "IssueTwoStageWorkflow" in (
        PACKAGE_ROOT / "workflows" / "issue" / "two_stage.py"
    ).read_text(encoding="utf-8")


def test_review_stage_profiles_are_not_named_adapters_or_runtime_profiles() -> None:
    review_stages_root = PACKAGE_ROOT / "review_stages"
    violations: list[str] = []

    assert [path for path in review_stages_root.rglob("runtime.py")] == []

    for path in review_stages_root.rglob("stage.py"):
        source = path.read_text(encoding="utf-8")
        if "Adapter" in source or "_ADAPTER" in source or "RuntimeProfile" in source:
            violations.append(str(path.relative_to(PACKAGE_ROOT)))

    assert violations == []


def test_workflow_input_preparation_is_a_single_runner_module() -> None:
    assert (PACKAGE_ROOT / "runner" / "input_preparation.py").is_file()
    assert not (PACKAGE_ROOT / "runner" / "inputs").exists()
    assert not (PACKAGE_ROOT / "runner" / "input_normalization.py").exists()


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


def test_run_local_issue_owns_local_issue_cli_flow() -> None:
    violations: list[str] = []
    path = PACKAGE_ROOT / "cli" / "run_local_issue.py"
    source = path.read_text(encoding="utf-8")

    for token in (
        "build_local_issue_bundle",
        "parse_args",
        "run_local_direct_workflow",
        "run_local_temporal_workflow",
        "--temporal",
    ):
        if token not in source:
            violations.append(
                f"{path.relative_to(PACKAGE_ROOT)} does not contain {token}"
            )
    for token in ("dispatch_request", "local_issue_runner", "run_local_issue_cli"):
        if token in source:
            violations.append(f"{path.relative_to(PACKAGE_ROOT)} contains {token}")

    assert violations == []


def test_delivery_planning_agent_does_not_build_stage_result_contracts() -> None:
    agent_path = PACKAGE_ROOT / "agents" / "delivery_planning" / "agent.py"
    source = agent_path.read_text(encoding="utf-8")
    violations = import_violations(
        agent_path,
        ("sec_review_agents.delivery_stages.planning.result",),
    )
    forbidden_tokens = ("DeliveryEntry",)

    assert violations == []
    assert [token for token in forbidden_tokens if token in source] == []


def test_delivery_result_builder_accepts_keep_case_ids() -> None:
    from sec_review_agents.delivery_stages.result import (
        build_delivery_result_from_outcomes,
    )

    signature = inspect.signature(build_delivery_result_from_outcomes)

    assert "keep_case_ids" in signature.parameters
    assert "keep_case_results" not in signature.parameters
    assert "run_artifacts_root" not in signature.parameters


def test_delivery_result_module_does_not_own_execution_results() -> None:
    source = (PACKAGE_ROOT / "delivery_stages" / "result.py").read_text(
        encoding="utf-8"
    )
    forbidden_tokens = (
        "DeliveryExecutionResult",
        "build_delivery_execution_result",
    )

    assert [token for token in forbidden_tokens if token in source] == []


def test_delivery_model_does_not_own_result_builders_or_models() -> None:
    source = (PACKAGE_ROOT / "delivery_stages" / "model.py").read_text(encoding="utf-8")
    forbidden_tokens = (
        "BaseModel",
        "DeliveryExecutionResult",
        "DeliveryArtifact",
        "DeliveryResult",
        "build_delivery_result",
    )

    assert [token for token in forbidden_tokens if token in source] == []


def test_delivery_planning_stage_does_not_own_input_projection() -> None:
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
    old_root = PACKAGE_ROOT / "delivery_stages" / "patch_synthesis"
    assert [path.name for path in old_root.glob("*.py")] == []

    path = PACKAGE_ROOT / "delivery_stages" / "execution" / "patch_synthesis.py"
    source = path.read_text(encoding="utf-8")
    forbidden_tokens = (
        "create_patch_synthesis_outcomes",
        "ThreadPoolExecutor",
        "as_completed",
        "repository-delivery",
    )

    assert path.exists()
    assert [token for token in forbidden_tokens if token in source] == []
