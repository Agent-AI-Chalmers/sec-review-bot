from typing import Any

from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    effective_issue_strategy,
)
from sec_review_agents.runner.input_preparation import prepare_workflow_input
from sec_review_agents.runtime.runtime_config import runtime_context_from_config
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest


def build_local_workflow_request(
    bundle: ReviewBundle,
    *,
    timeout_seconds: int,
) -> InternalWorkflowRequest:
    return InternalWorkflowRequest(
        workflow=bundle.workflow,
        run_id=bundle.run_id,
        prepared_input=prepare_workflow_input(
            bundle.input,
            workflow=bundle.workflow,
            artifact_root_path=bundle.artifact_root_path,
        ),
        timeout_seconds=timeout_seconds,
        runtime_context=runtime_context_from_config(bundle.runtime_config),
        memory_extraction_registration_enabled=False,
    )


def local_workflow_id(bundle: ReviewBundle) -> str:
    issue_strategy = effective_issue_strategy(bundle)
    if issue_strategy != "default":
        return f"{bundle.run_id}:{issue_strategy}"
    return bundle.run_id


def direct_run_for_bundle(bundle: ReviewBundle) -> Any:
    workflow_name = bundle.workflow
    if workflow_name == "issue-review":
        issue_strategy = effective_issue_strategy(bundle)
        from sec_review_agents.workflows.issue.direct import run_issue_review_direct
        from sec_review_agents.workflows.issue.single_agent import (
            run_issue_single_agent_direct,
        )
        from sec_review_agents.workflows.issue.two_stage import (
            run_issue_two_stage_direct,
        )

        if issue_strategy == "two-stage":
            return run_issue_two_stage_direct
        if issue_strategy == "single-agent":
            return run_issue_single_agent_direct
        return run_issue_review_direct
    if workflow_name == "pull-request-review":
        from sec_review_agents.workflows.pull_request.direct import (
            run_pull_request_review_direct,
        )

        return run_pull_request_review_direct
    if workflow_name == "repository-review":
        from sec_review_agents.workflows.repository.direct import (
            run_repository_review_direct,
        )

        return run_repository_review_direct
    raise ValueError(f"Unsupported local direct workflow: {workflow_name}")


def temporal_run_for_bundle(bundle: ReviewBundle) -> Any:
    workflow_name = bundle.workflow
    if workflow_name == "issue-review":
        issue_strategy = effective_issue_strategy(bundle)
        from sec_review_agents.workflows.issue.single_agent import (
            IssueSingleAgentWorkflow,
        )
        from sec_review_agents.workflows.issue.two_stage import IssueTwoStageWorkflow
        from sec_review_agents.workflows.issue.workflow import IssueReviewWorkflow

        if issue_strategy == "two-stage":
            return IssueTwoStageWorkflow.run
        if issue_strategy == "single-agent":
            return IssueSingleAgentWorkflow.run
        return IssueReviewWorkflow.run
    if workflow_name == "pull-request-review":
        from sec_review_agents.workflows.pull_request.workflow import (
            PullRequestReviewWorkflow,
        )

        return PullRequestReviewWorkflow.run
    if workflow_name == "repository-review":
        from sec_review_agents.workflows.repository.workflow import (
            RepositoryReviewWorkflow,
        )

        return RepositoryReviewWorkflow.run
    raise ValueError(f"Unsupported local Temporal workflow: {workflow_name}")


__all__ = [
    "build_local_workflow_request",
    "direct_run_for_bundle",
    "local_workflow_id",
    "temporal_run_for_bundle",
]
